import 'reflect-metadata';
import {
  NFT_OWNERS_TABLE,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import type { DbQueryOptions } from '@/db-query.options';
import { DbPoolName } from '@/db-query.options';
import type { Block } from '@/ethereum-rpc/ethereum-rpc-types';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import {
  blockHashOf,
  erc1155TransferBatchLog,
  erc1155TransferSingleLog,
  txHashOf
} from '@/tests/fixtures/nft-transfer-log.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import type { StateAuditRpc } from './block-anchors';
import { StateAuditDb } from './state-audit.db';
import type { StateAuditRequest } from './state-audit.options';
import { runStateAudit } from './state-audit.service';

const MEMES = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const ZERO = NULL_ADDRESS.toLowerCase();
const ALICE = '0x2222222222222222222222222222222222222222';
const BOB = '0x3333333333333333333333333333333333333333';
const CAROL = '0x4444444444444444444444444444444444444444';
const FROM_BLOCK = 1_000;
const TO_BLOCK = 1_010;
const OWNERS_BLOCK = 2_000;
const MINT_TX = txHashOf(1);
const SALE_TX = txHashOf(2);
const GIFT_TX = txHashOf(3);

/**
 * Wraps the test executor so any statement that is not a SELECT fails the
 * test. The audit must stay read-only by construction; this proves it.
 */
class ReadOnlyGuard extends SqlExecutor {
  readonly statements: string[] = [];
  constructor(private readonly delegate: SqlExecutor) {
    super();
  }
  async execute<T = any>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    this.statements.push(sql);
    if (!/^\s*SELECT\b/i.test(sql)) {
      throw new Error(`state audit executed a non-SELECT statement: ${sql}`);
    }
    if (options?.forcePool !== DbPoolName.READ) {
      throw new Error(`state audit did not force the READ pool: ${sql}`);
    }
    return this.delegate.execute<T>(sql, params, options);
  }
  async executeNativeQueriesInTransaction<T>(
    _executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>,
    _options?: SqlTransactionOptions
  ): Promise<T> {
    throw new Error('state audit opened a transaction');
  }
}

function block(number: number): Block {
  return {
    number,
    hash: blockHashOf(number),
    parentHash: blockHashOf(number - 1),
    timestamp: 0,
    nonce: '0x0',
    difficulty: BigInt(0),
    gasLimit: BigInt(0),
    gasUsed: BigInt(0),
    miner: ALICE,
    extraData: '0x',
    baseFeePerGas: null,
    transactions: []
  };
}

/** Three transactions: a 5-unit mint to Alice, a 2-unit sale to Bob, a gift to Carol. */
function chainLogs() {
  return [
    erc1155TransferSingleLog(MEMES, ZERO, ALICE, 1, 5, {
      blockNumber: 1_001,
      transactionHash: MINT_TX,
      logIndex: 0
    }),
    erc1155TransferSingleLog(MEMES, ALICE, BOB, 1, 1, {
      blockNumber: 1_005,
      transactionHash: SALE_TX,
      transactionIndex: 3,
      logIndex: 7
    }),
    erc1155TransferBatchLog(MEMES, ALICE, BOB, [1], [1], {
      blockNumber: 1_005,
      transactionHash: SALE_TX,
      transactionIndex: 3,
      logIndex: 8
    }),
    erc1155TransferSingleLog(MEMES, ALICE, CAROL, 1, 1, {
      blockNumber: 1_009,
      transactionHash: GIFT_TX,
      logIndex: 0
    })
  ];
}

function rpcWith(logs: () => ReturnType<typeof chainLogs>): StateAuditRpc {
  return {
    getBlock: jest
      .fn()
      .mockImplementation(async (tag) =>
        block(tag === 'finalized' ? 5_000 : Number(tag))
      ),
    getLogs: jest.fn().mockImplementation(async () => logs())
  };
}

function ledgerRow(
  transaction: string,
  blockNumber: number,
  from: string,
  to: string,
  tokenCount: number
) {
  return {
    created_at: new Date('2026-01-01T00:00:00Z'),
    transaction,
    block: blockNumber,
    transaction_date: new Date('2026-01-01T00:00:00Z'),
    from_address: from,
    to_address: to,
    contract: MEMES,
    token_id: 1,
    token_count: tokenCount,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

function ownerRow(wallet: string, balance: number) {
  return {
    wallet,
    contract: MEMES,
    token_id: 1,
    balance,
    block_reference: OWNERS_BLOCK
  };
}

const request: StateAuditRequest = {
  contract: 'memes',
  fromBlock: FROM_BLOCK,
  toBlock: TO_BLOCK,
  chainId: 1,
  wallets: [],
  out: null,
  format: 'json'
};

function withGuard(
  body: (guard: () => ReadOnlyGuard, unguarded: () => SqlExecutor) => void
) {
  let original: SqlExecutor;
  let guard: ReadOnlyGuard;
  beforeEach(() => {
    original = sqlExecutor;
    guard = new ReadOnlyGuard(original);
    setSqlExecutor(guard);
  });
  afterEach(() => {
    setSqlExecutor(original);
  });
  body(
    () => guard,
    () => original
  );
}

describeWithSeed(
  'state audit against a drifted ledger',
  [
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        ledgerRow(MINT_TX, 1_001, ZERO, ALICE, 5),
        // Historical ERC-1155 quantity recorded as 1 although the chain moved 2.
        ledgerRow(SALE_TX, 1_005, ALICE, BOB, 1)
        // GIFT_TX is wholly missing from the ledger.
      ]
    },
    {
      table: NFT_OWNERS_TABLE,
      // Owners were built from the drifted ledger: Alice 4, Bob 1, no Carol.
      rows: [ownerRow(ALICE, 4), ownerRow(BOB, 1)]
    }
  ],
  () => {
    withGuard((guard) => {
      it('finds the wrong quantity, the missing transfer and the stale owner balances without writing', async () => {
        const db = new StateAuditDb(() => guard());
        const rpc = rpcWith(chainLogs);
        const manifest = await runStateAudit(request, {
          rpc,
          db,
          chainId: 1,
          now: () => new Date('2026-11-09T00:00:00.000Z')
        });

        expect(manifest.status).toBe('differences_found');
        expect(manifest.inconclusive_reasons).toEqual([]);
        expect(manifest.summary).toEqual({
          missing_transaction: 1,
          missing_edge: 0,
          token_count_mismatch: 1,
          token_id_mismatch: 0,
          unexpected_row: 0,
          owner_balance_mismatch: 3
        });
        expect(manifest.ledger_before_image.row_count).toBe(2);
        expect(manifest.digests.ledger_before_image).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.digests.chain_edges).toMatch(/^[0-9a-f]{64}$/);

        const mismatch = manifest.discrepancies.find(
          (d) => d.type === 'token_count_mismatch'
        );
        expect(mismatch).toMatchObject({
          transaction: SALE_TX,
          stored_row: {
            from_address: ALICE,
            to_address: BOB,
            token_id: '1',
            token_count: 1
          },
          expected_row: {
            token_count: 2,
            log_indexes: [7, 8],
            block_hash: blockHashOf(1_005)
          }
        });
        const missing = manifest.discrepancies.find(
          (d) => d.type === 'missing_transaction'
        );
        expect(missing).toMatchObject({
          transaction: GIFT_TX,
          block: 1_009,
          expected_rows: [
            { from_address: ALICE, to_address: CAROL, token_count: 1 }
          ]
        });
        expect(manifest.affected_wallets).toEqual([ALICE, BOB, CAROL]);
        expect(manifest.reconciliation_plan).toMatchObject({
          consumers: ['owners', 'activity'],
          wallets: [ALICE, BOB, CAROL]
        });

        const owners = manifest.derived_checks.owner_balance;
        expect(owners.status).toBe('evaluated');
        expect(owners.owners_block_reference).toBe(OWNERS_BLOCK);
        expect(owners.wallets_checked).toEqual([ALICE, BOB, CAROL]);
        const balances = manifest.discrepancies
          .filter((d) => d.type === 'owner_balance_mismatch')
          .map((d) =>
            d.type === 'owner_balance_mismatch'
              ? [
                  d.wallet,
                  d.stored_row?.balance ?? null,
                  d.expected_row.balance
                ]
              : null
          );
        expect(balances).toEqual([
          [ALICE, 4, 2],
          [BOB, 1, 2],
          [CAROL, null, 1]
        ]);

        expect(
          manifest.inspected.transactions.map((t) => t.transaction)
        ).toEqual([MINT_TX, SALE_TX, GIFT_TX]);
        expect(manifest.inspected.log_count).toBe(4);
        expect(manifest.plan_digest).toMatch(/^[0-9a-f]{64}$/);

        expect(guard().statements.length).toBeGreaterThanOrEqual(4);
        guard().statements.forEach((sql) =>
          expect(sql).toMatch(/^\s*SELECT\b/i)
        );
      });

      it('restricts the derived check to --wallets when given', async () => {
        const manifest = await runStateAudit(
          { ...request, wallets: [BOB] },
          {
            rpc: rpcWith(chainLogs),
            db: new StateAuditDb(() => guard()),
            chainId: 1
          }
        );
        expect(manifest.derived_checks.owner_balance.wallets_checked).toEqual([
          BOB
        ]);
        expect(manifest.summary.owner_balance_mismatch).toBe(1);
      });

      it('reports an RPC failure as inconclusive and reads nothing from the database', async () => {
        const rpc = rpcWith(() => {
          throw new Error('rate limited');
        });
        const manifest = await runStateAudit(request, {
          rpc,
          db: new StateAuditDb(() => guard()),
          chainId: 1
        });
        expect(manifest.status).toBe('inconclusive');
        expect(manifest.inconclusive_reasons).toEqual([
          { code: 'rpc_error', detail: 'rate limited' }
        ]);
        expect(manifest.discrepancies).toEqual([]);
        expect(guard().statements).toEqual([]);
      });

      it('reports an unknown contract as unsupported without touching the database', async () => {
        const manifest = await runStateAudit(
          { ...request, contract: `0x${'f'.repeat(40)}` },
          {
            rpc: rpcWith(chainLogs),
            db: new StateAuditDb(() => guard()),
            chainId: 1
          }
        );
        expect(manifest.status).toBe('inconclusive');
        expect(manifest.inconclusive_reasons[0].code).toBe(
          'unsupported_contract'
        );
        expect(guard().statements).toEqual([]);
      });
    });
  }
);

describeWithSeed(
  'state audit against a correct ledger',
  [
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        ledgerRow(MINT_TX, 1_001, ZERO, ALICE, 5),
        ledgerRow(SALE_TX, 1_005, ALICE, BOB, 2),
        ledgerRow(GIFT_TX, 1_009, ALICE, CAROL, 1)
      ]
    },
    {
      table: NFT_OWNERS_TABLE,
      rows: [ownerRow(ALICE, 2), ownerRow(BOB, 2), ownerRow(CAROL, 1)]
    }
  ],
  () => {
    withGuard((guard, unguarded) => {
      it('is clean, including the derived owner check for explicit wallets', async () => {
        const manifest = await runStateAudit(
          { ...request, wallets: [ALICE, BOB, CAROL] },
          {
            rpc: rpcWith(chainLogs),
            db: new StateAuditDb(() => guard()),
            chainId: 1
          }
        );
        expect(manifest.inconclusive_reasons).toEqual([]);
        expect(manifest.discrepancies).toEqual([]);
        expect(manifest.status).toBe('clean');
        expect(manifest.derived_checks.owner_balance.status).toBe('evaluated');
        expect(manifest.ledger_before_image.row_count).toBe(3);
        expect(manifest.reconciliation_plan.wallets).toEqual([]);
        guard().statements.forEach((sql) =>
          expect(sql).toMatch(/^\s*SELECT\b/i)
        );
      });

      it('skips the derived check when owners have not published the window yet', async () => {
        // Test setup only: the audit itself still runs through the guard.
        await unguarded().execute(
          `UPDATE ${NFT_OWNERS_TABLE} SET block_reference = :ref`,
          { ref: TO_BLOCK - 1 }
        );
        const manifest = await runStateAudit(
          { ...request, wallets: [ALICE] },
          {
            rpc: rpcWith(chainLogs),
            db: new StateAuditDb(() => guard()),
            chainId: 1
          }
        );
        expect(manifest.status).toBe('clean');
        expect(manifest.derived_checks.owner_balance.status).toBe('skipped');
        expect(manifest.derived_checks.owner_balance.reason).toContain(
          'below the window end'
        );
      });
    });
  }
);
