import { sqlExecutor } from '@/sql-executor';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { sweepHoldingsKeys } from './holdings-key-sweep';
import { readHoldingsKeySweepAction } from './holdings-key-sweep-action';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
}));
jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { enqueueFor: jest.fn() }
}));

const execute = jest.mocked(sqlExecutor.execute);
const enqueueFor = jest.mocked(transferReconciliationDb.enqueueFor);

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}
const [A, B, C, D] = [1, 2, 3, 4].map(wallet);

/** Keys the wallet rows map to, and keys stored, per consolidated table. */
function tables(
  byTable: Record<string, { expected: string[]; stored: string[] }>
) {
  execute.mockImplementation(async (sql: string) => {
    const expectedFor = /FROM (\w+) w\s/.exec(sql)?.[1];
    if (expectedFor) {
      const table = Object.keys(byTable).find(
        (name) => byTable[name].expected && expectedFor === walletTable(name)
      );
      return (table ? byTable[table].expected : []).map((k) => ({ k }));
    }
    const storedIn = /FROM (\w+)\s/.exec(sql)?.[1] ?? '';
    return (byTable[storedIn]?.stored ?? []).map((k) => ({ k }));
  });
}

function walletTable(consolidated: string): string {
  return {
    nft_owners_consolidation: 'nft_owners',
    owners_balances_consolidation: 'owners_balances',
    aggregated_activity_consolidation: 'aggregated_activity'
  }[consolidated]!;
}

describe('sweepHoldingsKeys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports clean tables and queues nothing', async () => {
    const key = [A, B].join('-');
    tables({
      nft_owners_consolidation: { expected: [key, C], stored: [key, C] },
      owners_balances_consolidation: { expected: [key], stored: [key] },
      aggregated_activity_consolidation: { expected: [C], stored: [C] }
    });

    const results = await sweepHoldingsKeys({ repair: true });

    expect(results.map((r) => r.wallets_to_queue)).toEqual([0, 0, 0]);
    expect(enqueueFor).not.toHaveBeenCalled();
  });

  it('queues the wallets of stale and missing keys, and of a wallet stored under two keys, for the loop of each table', async () => {
    const joined = [A, B, C].join('-');
    const old = [A, B].join('-');
    tables({
      // C joined A and B: the old key is stale, the new one missing.
      nft_owners_consolidation: { expected: [joined], stored: [old, C] },
      // C stored alone and in the group.
      owners_balances_consolidation: {
        expected: [joined],
        stored: [joined, C]
      },
      aggregated_activity_consolidation: { expected: [D], stored: [D] }
    });

    const results = await sweepHoldingsKeys({ repair: true });

    expect(results).toEqual([
      expect.objectContaining({
        consumer: 'owners',
        stale_keys: 2,
        missing_keys: 1,
        wallets_to_queue: 3,
        wallets_queued: 3
      }),
      expect.objectContaining({
        consumer: 'balances',
        stale_keys: 1,
        missing_keys: 0,
        wallets_in_two_keys: 1,
        wallets_to_queue: 1
      }),
      expect.objectContaining({ consumer: 'activity', wallets_to_queue: 0 })
    ]);
    expect(enqueueFor).toHaveBeenCalledWith([A, B, C], 'owners');
    expect(enqueueFor).toHaveBeenCalledWith([C], 'balances');
  });

  it('only reports without repair', async () => {
    tables({
      nft_owners_consolidation: { expected: [A], stored: [B] },
      owners_balances_consolidation: { expected: [], stored: [] },
      aggregated_activity_consolidation: { expected: [], stored: [] }
    });

    const results = await sweepHoldingsKeys({ repair: false });

    expect(results[0]).toMatchObject({
      wallets_to_queue: 2,
      wallets_queued: 0
    });
    expect(enqueueFor).not.toHaveBeenCalled();
  });

  it('queues at most 2,000 wallets per loop per sweep', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => wallet(1000 + i));
    tables({
      nft_owners_consolidation: { expected: many, stored: [] },
      owners_balances_consolidation: { expected: [], stored: [] },
      aggregated_activity_consolidation: { expected: [], stored: [] }
    });

    const results = await sweepHoldingsKeys({ repair: true });

    expect(results[0]).toMatchObject({
      missing_keys: 2500,
      wallets_to_queue: 2500,
      wallets_queued: 2000
    });
    expect(enqueueFor.mock.calls[0][0]).toHaveLength(2000);
  });
});

describe('readHoldingsKeySweepAction', () => {
  it('reads a sweep request and passes other invocations through', () => {
    expect(
      readHoldingsKeySweepAction({ action: 'holdings-key-sweep' })
    ).toEqual({ action: 'holdings-key-sweep', repair: false });
    expect(
      readHoldingsKeySweepAction({ action: 'holdings-key-sweep', repair: true })
    ).toEqual({ action: 'holdings-key-sweep', repair: true });
    expect(readHoldingsKeySweepAction(undefined)).toBeNull();
    expect(
      readHoldingsKeySweepAction({ source: 'aws.events', detail: {} })
    ).toBeNull();
  });

  it('refuses another action or a malformed repair flag', () => {
    expect(() => readHoldingsKeySweepAction({ action: 'reset' })).toThrow(
      'Unsupported'
    );
    expect(() =>
      readHoldingsKeySweepAction({
        action: 'holdings-key-sweep',
        repair: 'yes'
      })
    ).toThrow('repair');
  });
});
