import type { Block } from '@/ethereum-rpc/ethereum-rpc-types';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import {
  blockHashOf,
  erc1155TransferSingleLog,
  txHashOf
} from '@/tests/fixtures/nft-transfer-log.fixture';
import type { StateAuditRpc } from './block-anchors';
import type { StateAuditDb } from './state-audit.db';
import { computePlanDigest } from './state-audit.manifest';
import type { StateAuditRequest } from './state-audit.options';
import {
  describeError,
  resolveAuditContract,
  runStateAudit
} from './state-audit.service';

const MEMES = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';

function request(
  overrides: Partial<StateAuditRequest> = {}
): StateAuditRequest {
  return {
    contract: 'memes',
    fromBlock: 100,
    toBlock: 110,
    chainId: 1,
    wallets: [],
    out: null,
    format: 'json',
    ...overrides
  };
}

function block(number: number, hash: string = blockHashOf(number)): Block {
  return {
    number,
    hash,
    parentHash: blockHashOf(number - 1),
    timestamp: 0,
    nonce: '0x0',
    difficulty: BigInt(0),
    gasLimit: BigInt(0),
    gasUsed: BigInt(0),
    miner: A,
    extraData: '0x',
    baseFeePerGas: null,
    transactions: []
  };
}

function rpcWith(options: {
  finalized?: number;
  hashes?: () => Record<number, string>;
  logs?: () => ReturnType<typeof erc1155TransferSingleLog>[];
}): StateAuditRpc {
  return {
    getBlock: jest.fn().mockImplementation(async (tag) => {
      if (tag === 'finalized') return block(options.finalized ?? 1_000);
      const hashes = options.hashes?.() ?? {};
      return block(Number(tag), hashes[Number(tag)]);
    }),
    getLogs: jest.fn().mockImplementation(async () => options.logs?.() ?? [])
  };
}

function dbWith(
  overrides: Partial<Record<keyof StateAuditDb, jest.Mock>> = {}
): StateAuditDb & Record<string, jest.Mock> {
  return {
    readLedgerRows: jest.fn().mockResolvedValue([]),
    readLedgerHistoryForWallets: jest.fn().mockResolvedValue([]),
    readOwnersBlockReference: jest.fn().mockResolvedValue(null),
    readOwnerRows: jest.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as StateAuditDb & Record<string, jest.Mock>;
}

const now = () => new Date('2026-11-09T00:00:00.000Z');

describe('resolveAuditContract', () => {
  it('maps names and known addresses, and refuses NextGen and unknown contracts', () => {
    expect(resolveAuditContract('memes')).toEqual({
      supported: true,
      address: MEMES,
      name: 'memes'
    });
    expect(
      resolveAuditContract(MEMES.toUpperCase().replace('0X', '0x'))
    ).toMatchObject({
      supported: true,
      name: 'memes'
    });
    const nextgen = resolveAuditContract(
      NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET]
    );
    expect(nextgen.supported).toBe(false);
    expect(nextgen).toMatchObject({
      reason: expect.stringContaining('NextGen')
    });
    expect(resolveAuditContract(`0x${'f'.repeat(40)}`)).toMatchObject({
      supported: false,
      reason: expect.stringContaining('not Memes, Gradients or Meme Lab')
    });
  });
});

describe('describeError', () => {
  it('redacts URLs and truncates', () => {
    const described = describeError(
      new Error(`failed https://user:key@rpc.example/v1 ${'x'.repeat(400)}`)
    );
    expect(described).not.toContain('rpc.example');
    expect(described.startsWith('failed <url>')).toBe(true);
    expect(described.length).toBeLessThanOrEqual(300);
  });
});

describe('runStateAudit', () => {
  it('reports unsupported contracts as inconclusive without touching RPC or DB', async () => {
    const rpc = rpcWith({});
    const db = dbWith();
    const manifest = await runStateAudit(
      request({ contract: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET] }),
      { rpc, db, chainId: 1, now }
    );
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons).toEqual([
      {
        code: 'unsupported_contract',
        detail: expect.stringContaining('NextGen')
      }
    ]);
    expect(manifest.contract.supported).toBe(false);
    expect(rpc.getBlock).not.toHaveBeenCalled();
    expect(db.readLedgerRows).not.toHaveBeenCalled();
  });

  it('reports a chain id mismatch as inconclusive before any network access', async () => {
    const rpc = rpcWith({});
    const manifest = await runStateAudit(request({ chainId: 11155111 }), {
      rpc,
      db: dbWith(),
      chainId: 1,
      now
    });
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons[0].code).toBe('chain_id_mismatch');
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it('refuses windows above the finalized head', async () => {
    const manifest = await runStateAudit(request({ toBlock: 110 }), {
      rpc: rpcWith({ finalized: 105 }),
      db: dbWith(),
      chainId: 1,
      now
    });
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons[0].code).toBe('window_not_finalized');
  });

  it('reports RPC failures as inconclusive and never reads the ledger', async () => {
    const rpc = rpcWith({
      logs: () => {
        throw new Error('getLogs failed at https://rpc.example/secret');
      }
    });
    const db = dbWith();
    const manifest = await runStateAudit(request(), {
      rpc,
      db,
      chainId: 1,
      now
    });
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons).toEqual([
      { code: 'rpc_error', detail: 'getLogs failed at <url>' }
    ]);
    expect(db.readLedgerRows).not.toHaveBeenCalled();
  });

  it('detects changed anchors after reading logs', async () => {
    let calls = 0;
    const rpc = rpcWith({
      hashes: (): Record<number, string> => {
        calls += 1;
        return calls > 2 ? { 110: `0x${'c'.repeat(64)}` } : {};
      }
    });
    const manifest = await runStateAudit(request(), {
      rpc,
      db: dbWith(),
      chainId: 1,
      now
    });
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons.map((r) => r.code)).toEqual([
      'anchors_changed'
    ]);
  });

  it('reports database failures as inconclusive', async () => {
    const manifest = await runStateAudit(request(), {
      rpc: rpcWith({}),
      db: dbWith({
        readLedgerRows: jest
          .fn()
          .mockRejectedValue(new Error('read replica down'))
      }),
      chainId: 1,
      now
    });
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons).toEqual([
      { code: 'database_error', detail: 'read replica down' }
    ]);
  });

  it('produces a clean, deterministic manifest for an empty window', async () => {
    const deps = { rpc: rpcWith({}), db: dbWith(), chainId: 1, now };
    const first = await runStateAudit(request(), deps);
    const second = await runStateAudit(request(), deps);
    expect(first.status).toBe('clean');
    expect(first.anchors).toEqual({
      from_block: { number: 100, hash: blockHashOf(100) },
      to_block: { number: 110, hash: blockHashOf(110) },
      finalized: { number: 1_000, hash: blockHashOf(1_000) }
    });
    expect(first.inspected_scope).toEqual({
      from_block: 100,
      to_block: 110,
      blocks_inspected: 11,
      complete: true,
      chunks: [{ from_block: 100, to_block: 110, log_count: 0 }]
    });
    expect(first.plan_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.plan_digest).toBe(computePlanDigest(first));
    expect(second).toEqual(first);
    expect(first.derived_checks.owner_balance.status).toBe('not_applicable');
  });

  it('marks a capped log response inconclusive even when the diff finds nothing', async () => {
    const deps = {
      rpc: rpcWith({
        logs: () => {
          const logs = [];
          for (let index = 0; index < 10_000; index += 1) {
            logs.push(
              erc1155TransferSingleLog(MEMES, A, B, 1, 1, {
                blockNumber: 100,
                transactionHash: txHashOf(index),
                logIndex: index
              })
            );
          }
          return logs;
        }
      }),
      db: dbWith({
        readLedgerRows: jest.fn().mockImplementation(async () => {
          const rows = [];
          for (let index = 0; index < 10_000; index += 1) {
            rows.push({
              transaction: txHashOf(index),
              block: 100,
              from_address: A,
              to_address: B,
              contract: MEMES,
              token_id: '1',
              token_count: 1
            });
          }
          return rows;
        })
      }),
      chainId: 1,
      now
    };
    const manifest = await runStateAudit(request(), deps);
    expect(manifest.discrepancies).toEqual([]);
    expect(manifest.status).toBe('inconclusive');
    expect(manifest.inconclusive_reasons.map((r) => r.code)).toEqual([
      'log_response_capped'
    ]);
    expect(manifest.inspected_scope.complete).toBe(false);
  });
});
