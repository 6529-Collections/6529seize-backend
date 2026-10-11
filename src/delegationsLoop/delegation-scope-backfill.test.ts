import { DELEGATIONS_IFACE } from '@/abis/delegations';
import type { Log } from '@/alchemy-sdk';
import {
  DELEGATION_CONTRACT,
  DELEGATION_CONTRACT_DEPLOYMENT_BLOCK,
  MEMES_CONTRACT,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION,
  USE_CASE_MINTING
} from '@/constants';
import { DelegationEvent, EventType } from '@/entities/IDelegation';
import { getAddress } from 'ethers';
import {
  buildExpectedRows,
  DelegationRow,
  diffDelegationRows,
  readScopeBackfillConfig,
  runDelegationScopeBackfill,
  ScopeBackfillDeps
} from './delegation-scope-backfill';

const COLD = getAddress('0xc01d000000000000000000000000000000000c01');
const SAFE = getAddress('0x5afe00000000000000000000000000000000a5fe');
const HOT_1 = '0x1111111111111111111111111111111111111111';
const HOT_2 = '0x2222222222222222222222222222222222222222';
const HOT_3 = '0x3333333333333333333333333333333333333333';
const NOW = 1_800_000_000;

function row(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    block: 10,
    from_address: COLD,
    to_address: HOT_1,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 0,
    ...overrides
  };
}

function registration(overrides: Partial<DelegationEvent> = {}) {
  const event: DelegationEvent = {
    block: 10,
    type: EventType.REGISTER,
    wallet1: COLD,
    wallet2: HOT_1,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: NEVER_DATE,
    all_tokens: true,
    token_id: 0,
    ...overrides
  };
  return event;
}

function revocation(overrides: Partial<DelegationEvent> = {}) {
  const event: DelegationEvent = {
    block: 10,
    type: EventType.REVOKE,
    wallet1: COLD,
    wallet2: HOT_1,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    ...overrides
  };
  return event;
}

let nextLogIndex = 0;

function log(
  blockNumber: number,
  event: string,
  values: unknown[],
  transactionHash: string
): Log {
  const { data, topics } = DELEGATIONS_IFACE.encodeEventLog(event, values);
  return {
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    transactionIndex: 0,
    transactionHash,
    address: DELEGATION_CONTRACT.contract,
    data,
    topics,
    logIndex: nextLogIndex++,
    removed: false
  };
}

function deps(overrides: Partial<ScopeBackfillDeps> = {}) {
  return {
    latestProcessedBlock: jest.fn(async () => 100),
    scan: jest.fn(async () => ({
      logs: [] as Log[],
      registrations: [] as DelegationEvent[],
      revocations: [] as DelegationEvent[]
    })),
    readRows: jest.fn(async () => [] as DelegationRow[]),
    getTransaction: jest.fn(async () => null),
    applyDiff: jest.fn(async () => undefined),
    nowSeconds: () => NOW,
    ...overrides
  };
}

function expectedFrom(
  currentRows: DelegationRow[],
  registrations: DelegationEvent[],
  revocations: DelegationEvent[] = [],
  fromBlock = 1
) {
  return buildExpectedRows({
    fromBlock,
    currentRows,
    registrations,
    revocations
  });
}

describe('readScopeBackfillConfig', () => {
  it('is off unless the flag is set', () => {
    expect(readScopeBackfillConfig({})).toBeNull();
    expect(
      readScopeBackfillConfig({ DELEGATIONS_SCOPE_BACKFILL: ' ' })
    ).toBeNull();
  });

  it('defaults the start to the contract deployment block', () => {
    expect(
      readScopeBackfillConfig({ DELEGATIONS_SCOPE_BACKFILL: 'dry-run' })
    ).toEqual({
      mode: 'dry-run',
      fromBlock: DELEGATION_CONTRACT_DEPLOYMENT_BLOCK
    });
  });

  it('accepts apply and an explicit start block', () => {
    expect(
      readScopeBackfillConfig({
        DELEGATIONS_SCOPE_BACKFILL: 'apply',
        DELEGATIONS_SCOPE_BACKFILL_FROM_BLOCK: '20000000'
      })
    ).toEqual({ mode: 'apply', fromBlock: 20_000_000 });
  });

  it('rejects an unknown mode or a bad start block', () => {
    expect(() =>
      readScopeBackfillConfig({ DELEGATIONS_SCOPE_BACKFILL: 'yes' })
    ).toThrow('must be "dry-run" or "apply"');
    expect(() =>
      readScopeBackfillConfig({
        DELEGATIONS_SCOPE_BACKFILL: 'apply',
        DELEGATIONS_SCOPE_BACKFILL_FROM_BLOCK: '-5'
      })
    ).toThrow('must be a block number');
  });
});

describe('expected rows and diff', () => {
  it('finds nothing to change when the rows already match', () => {
    const current = [row(), row({ block: 11, to_address: HOT_2 })];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [
        registration(),
        registration({ block: 11, wallet2: HOT_2 })
      ])
    );
    expect(diff).toEqual({
      inserts: [],
      deletes: [],
      updates: [],
      unchanged: 2
    });
  });

  it('fixes a token-specific row that was stored as all tokens', () => {
    const current = [row({ all_tokens: true, token_id: 61 })];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [registration({ all_tokens: false, token_id: 61 })])
    );
    expect(diff.updates).toEqual([
      {
        current: current[0],
        expected: row({ all_tokens: false, token_id: 61 }),
        fields: ['all_tokens']
      }
    ]);
  });

  it('fixes an expiry that was stored as never', () => {
    const current = [row()];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [registration({ expiry: 1_714_521_600 })])
    );
    expect(diff.updates.map((u) => [u.fields, u.expected.expiry])).toEqual([
      [['expiry'], 1_714_521_600]
    ]);
  });

  it('deletes a row that a later revocation removed', () => {
    const current = [row({ block: 10 }), row({ block: 12 })];
    const diff = diffDelegationRows(
      current,
      expectedFrom(
        current,
        [registration({ block: 10 }), registration({ block: 12 })],
        [revocation({ block: 11 })]
      )
    );
    expect(diff.deletes).toEqual([current[0]]);
    expect(diff.unchanged).toBe(1);
  });

  it('keeps a registration made after a revocation in the same block', () => {
    const current = [row({ block: 10 })];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [registration({ block: 10 })], [revocation()])
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.deletes).toEqual([]);
  });

  it('inserts a missing row', () => {
    const diff = diffDelegationRows(
      [],
      expectedFrom([], [registration({ expiry: 5 })])
    );
    expect(diff.inserts).toEqual([row({ expiry: 5 })]);
  });

  it('keeps the last registration in log order for a shared key', () => {
    const expected = expectedFrom(
      [],
      [
        registration({ all_tokens: false, token_id: 7 }),
        registration({ all_tokens: false, token_id: 8 })
      ]
    );
    expect(expected).toEqual([row({ all_tokens: false, token_id: 8 })]);
  });

  it('matches addresses case-insensitively', () => {
    const current = [row({ from_address: COLD.toLowerCase() })];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [registration()])
    );
    expect(diff.unchanged).toBe(1);
  });

  it('keeps rows before the start block unless a scanned revocation removed them', () => {
    const current = [
      row({ block: 5, to_address: HOT_1 }),
      row({ block: 5, to_address: HOT_2 })
    ];
    const diff = diffDelegationRows(
      current,
      expectedFrom(current, [], [revocation({ block: 50, wallet2: HOT_2 })], 20)
    );
    expect(diff.deletes).toEqual([current[1]]);
    expect(diff.unchanged).toBe(1);
  });

  // A revocation deletes every registration the delegator holds for that
  // delegate, collection and use case at that moment; later registrations
  // survive. Rows below share one pair and differ only in block and token.
  describe('revocation sequences for one delegator and delegate', () => {
    const tokenA = { all_tokens: false, token_id: 1 };
    const tokenB = { all_tokens: false, token_id: 2 };

    it('register@10, revoke@15, register@20: keeps only the block-20 row', () => {
      const current = [
        row({ block: 10, ...tokenA }),
        row({ block: 20, ...tokenB })
      ];
      const diff = diffDelegationRows(
        current,
        expectedFrom(
          current,
          [
            registration({ block: 10, ...tokenA }),
            registration({ block: 20, ...tokenB })
          ],
          [revocation({ block: 15 })]
        )
      );
      expect(diff.deletes).toEqual([current[0]]);
      expect(diff.unchanged).toBe(1);
    });

    it('register@10, register@20, revoke@25: deletes both rows', () => {
      const current = [
        row({ block: 10, ...tokenA }),
        row({ block: 20, ...tokenB })
      ];
      const diff = diffDelegationRows(
        current,
        expectedFrom(
          current,
          [
            registration({ block: 10, ...tokenA }),
            registration({ block: 20, ...tokenB })
          ],
          [revocation({ block: 25 })]
        )
      );
      expect(diff.deletes).toEqual(current);
      expect(diff.unchanged).toBe(0);
    });

    it('register@N (log 1) then revoke@N (log 2): deletes a pre-existing stale row', () => {
      // The scan drops this registration by log index, so the stale row the
      // old indexer kept has no expected counterpart.
      const stale = row({ block: 30 });
      const diff = diffDelegationRows(
        [stale],
        expectedFrom([stale], [], [revocation({ block: 30 })])
      );
      expect(diff.deletes).toEqual([stale]);
    });

    it('revoke@N (log 1) then register@N (log 2): keeps the row', () => {
      const current = [row({ block: 30 })];
      const diff = diffDelegationRows(
        current,
        expectedFrom(
          current,
          [registration({ block: 30 })],
          [revocation({ block: 30 })]
        )
      );
      expect(diff.deletes).toEqual([]);
      expect(diff.unchanged).toBe(1);
    });

    it('a stale row at or after the start block is deleted unless the scan registered it', () => {
      const current = [
        row({ block: 40 }),
        row({ block: 41, to_address: HOT_2 })
      ];
      const diff = diffDelegationRows(
        current,
        expectedFrom(
          current,
          [registration({ block: 41, wallet2: HOT_2 })],
          [],
          40
        )
      );
      expect(diff.deletes).toEqual([current[0]]);
      expect(diff.unchanged).toBe(1);
    });
  });

  it('never compares or touches use case 999 rows', () => {
    const consolidation = row({ use_case: USE_CASE_CONSOLIDATION });
    const diff = diffDelegationRows(
      [consolidation],
      [row({ use_case: USE_CASE_CONSOLIDATION, block: 99 })]
    );
    expect(diff).toEqual({
      inserts: [],
      deletes: [],
      updates: [],
      unchanged: 0
    });
  });
});

describe('runDelegationScopeBackfill', () => {
  beforeEach(() => {
    nextLogIndex = 0;
  });

  it('reports in dry-run and writes nothing', async () => {
    const d = deps({
      readRows: jest.fn(async () => [row()]),
      scan: jest.fn(async () => ({
        logs: [],
        registrations: [registration({ expiry: 1_000 })],
        revocations: []
      }))
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'dry-run', fromBlock: 1 },
      d
    );

    expect(d.scan).toHaveBeenCalledWith(1, 100);
    expect(report.diff.updates).toHaveLength(1);
    expect(report.applied).toBe(false);
    expect(d.applyDiff).not.toHaveBeenCalled();
  });

  it('writes the diff once in apply mode', async () => {
    const d = deps({
      readRows: jest.fn(async () => [row()]),
      scan: jest.fn(async () => ({
        logs: [],
        registrations: [registration({ expiry: 1_000 })],
        revocations: []
      }))
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      d
    );

    expect(report.applied).toBe(true);
    expect(d.applyDiff).toHaveBeenCalledTimes(1);
    expect(d.applyDiff).toHaveBeenCalledWith(report.diff);
  });

  it('writes nothing in apply mode when the rows already match', async () => {
    const d = deps({
      readRows: jest.fn(async () => [row()]),
      scan: jest.fn(async () => ({
        logs: [],
        registrations: [registration()],
        revocations: []
      }))
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      d
    );

    expect(report.applied).toBe(false);
    expect(d.applyDiff).not.toHaveBeenCalled();
  });

  it('leaves rows after the last processed block to the normal loop', async () => {
    const d = deps({
      latestProcessedBlock: jest.fn(async () => 50),
      readRows: jest.fn(async () => [row({ block: 60 })])
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'apply', fromBlock: 1 },
      d
    );

    expect(report.diff.deletes).toEqual([]);
    expect(d.applyDiff).not.toHaveBeenCalled();
  });

  it('fails before writing when a read fails', async () => {
    const failingScan = deps({
      scan: jest.fn(async () => {
        throw new Error('archive read failed');
      })
    });
    await expect(
      runDelegationScopeBackfill({ mode: 'apply', fromBlock: 1 }, failingScan)
    ).rejects.toThrow('archive read failed');
    expect(failingScan.applyDiff).not.toHaveBeenCalled();

    const failingTx = deps({
      scan: jest.fn(async () => ({
        logs: [
          log(
            10,
            'RegisterDelegation',
            [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, true, BigInt(0)],
            '0xaa'
          )
        ],
        registrations: [registration({ expiry: 1 })],
        revocations: []
      })),
      getTransaction: jest.fn(async () => {
        throw new Error('rpc down');
      })
    });
    await expect(
      runDelegationScopeBackfill({ mode: 'apply', fromBlock: 1 }, failingTx)
    ).rejects.toThrow('rpc down');
    expect(failingTx.applyDiff).not.toHaveBeenCalled();
  });

  it('fails when the loop has not processed the start block yet', async () => {
    const d = deps({ latestProcessedBlock: jest.fn(async () => 0) });
    await expect(
      runDelegationScopeBackfill({ mode: 'dry-run', fromBlock: 1 }, d)
    ).rejects.toThrow('No processed delegation blocks');
    expect(d.scan).not.toHaveBeenCalled();
  });

  it('counts a registration made from a contract constructor as a contract wallet', async () => {
    const d = deps({
      readRows: jest.fn(async () => [row()]),
      scan: jest.fn(async () => ({
        logs: [
          log(
            10,
            'RegisterDelegation',
            [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, true, BigInt(0)],
            '0xc0'
          )
        ],
        registrations: [registration({ expiry: 1 })],
        revocations: []
      })),
      getTransaction: jest.fn(async () => ({ to: null, data: '0x60806040' }))
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'dry-run', fromBlock: 1 },
      d
    );

    expect(report.causes['contract-wallet']).toBe(1);
    expect(report.causes.other).toBe(0);
  });

  it('counts changes by cause and the delegations they deactivate', async () => {
    const batchData = DELEGATIONS_IFACE.encodeFunctionData('batchDelegations', [
      [MEMES_CONTRACT],
      [HOT_2],
      [BigInt(2_000)],
      [USE_CASE_MINTING],
      [true],
      [BigInt(0)]
    ]);
    const directData = DELEGATIONS_IFACE.encodeFunctionData(
      'registerDelegationAddress',
      [MEMES_CONTRACT, HOT_3, NEVER_DATE, USE_CASE_MINTING, false, BigInt(5)]
    );
    const transactions: Record<string, { to: string; data: string }> = {
      '0x5a': { to: SAFE, data: '0x6a761202' },
      '0xba': { to: DELEGATION_CONTRACT.contract, data: batchData },
      '0xd1': { to: DELEGATION_CONTRACT.contract, data: directData }
    };
    const d = deps({
      readRows: jest.fn(async () => [
        row({ block: 10, from_address: SAFE }),
        row({ block: 11, to_address: HOT_2 }),
        row({ block: 12, to_address: HOT_3, token_id: 5 }),
        row({ block: 13 }),
        row({ block: 14, to_address: HOT_2 })
      ]),
      scan: jest.fn(async () => ({
        logs: [
          log(
            10,
            'RegisterDelegation',
            [SAFE, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, true, BigInt(0)],
            '0x5a'
          ),
          log(
            11,
            'RegisterDelegation',
            [COLD, MEMES_CONTRACT, HOT_2, USE_CASE_MINTING, true, BigInt(0)],
            '0xba'
          ),
          log(
            12,
            'RegisterDelegation',
            [COLD, MEMES_CONTRACT, HOT_3, USE_CASE_MINTING, false, BigInt(5)],
            '0xd1'
          ),
          log(
            13,
            'RegisterDelegation',
            [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING, true, BigInt(0)],
            '0x13'
          ),
          log(
            13,
            'RevokeDelegation',
            [COLD, MEMES_CONTRACT, HOT_1, USE_CASE_MINTING],
            '0x13'
          )
        ],
        registrations: [
          registration({ block: 10, wallet1: SAFE, expiry: 0 }),
          registration({ block: 11, wallet2: HOT_2, expiry: 2_000 }),
          registration({
            block: 12,
            wallet2: HOT_3,
            all_tokens: false,
            token_id: 5
          })
        ],
        revocations: [revocation({ block: 13 })]
      })),
      getTransaction: jest.fn(async (hash: string) => transactions[hash])
    });

    const report = await runDelegationScopeBackfill(
      { mode: 'dry-run', fromBlock: 1 },
      d
    );

    expect(report.causes).toEqual({
      'contract-wallet': 1,
      batch: 1,
      'token-specific': 1,
      'revoked-same-block': 1,
      'not-in-chain-history': 1,
      other: 0
    });
    expect(report.diff.updates).toHaveLength(3);
    expect(report.diff.deletes).toHaveLength(2);
    // Expiry 0 and 2,000 are in the past; both deleted rows were active.
    expect(report.deactivates).toBe(4);
    expect(report.activates).toBe(0);
    expect(d.getTransaction).toHaveBeenCalledTimes(3);
  });
});
