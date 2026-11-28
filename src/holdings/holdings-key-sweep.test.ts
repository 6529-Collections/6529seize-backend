import { sqlExecutor } from '@/sql-executor';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { sweepHoldingsKeys } from './holdings-key-sweep';
import { readHoldingsKeySweepAction } from './holdings-key-sweep-action';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
}));
jest.mock('@/transactions/transfer-reconciliation.db', () => ({
  transferReconciliationDb: { enqueueIfAbsent: jest.fn() }
}));

const execute = jest.mocked(sqlExecutor.execute);
const enqueueIfAbsent = jest.mocked(transferReconciliationDb.enqueueIfAbsent);

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}
const [A, B, C, D] = [1, 2, 3, 4].map(wallet);

interface World {
  /** Keys the holders in owners_balances map to. */
  holders: string[];
  /** Keys the wallets in aggregated_activity map to. */
  active: string[];
  /** Stored keys per consolidated table. */
  stored: Record<string, string[]>;
  sums?: {
    compared: number;
    differing: number;
    wallets: number;
    consolidated: number;
  };
}

function world(w: World) {
  execute.mockImplementation(async (sql: string) => {
    const walletTable = /FROM (\w+) w\s/.exec(sql)?.[1];
    if (walletTable === 'owners_balances') return w.holders.map((k) => ({ k }));
    if (walletTable === 'aggregated_activity')
      return w.active.map((k) => ({ k }));
    if (walletTable) throw new Error(`unexpected wallet table ${walletTable}`);
    if (sql.includes('AS compared'))
      return [
        { compared: w.sums?.compared ?? 0, differing: w.sums?.differing ?? 0 }
      ];
    if (sql.includes('AS consolidated'))
      return [
        {
          wallets: w.sums?.wallets ?? 0,
          consolidated: w.sums?.consolidated ?? 0
        }
      ];
    const table = /FROM (\w+)\s/.exec(sql)?.[1] ?? '';
    return (w.stored[table] ?? []).map((k) => ({ k }));
  });
}

const CLEAN_TABLES = {
  nft_owners_consolidation: [] as string[],
  owners_balances_consolidation: [] as string[],
  aggregated_activity_consolidation: [] as string[]
};

describe('sweepHoldingsKeys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the holders once for both owners and balances, and never nft_owners per row', async () => {
    const key = [A, B].join('-');
    world({
      holders: [key, C],
      active: [C],
      stored: {
        nft_owners_consolidation: [key, C],
        owners_balances_consolidation: [key, C],
        aggregated_activity_consolidation: [C]
      }
    });

    const report = await sweepHoldingsKeys({ repair: true });

    expect(report.tables.map((r) => r.wallets_to_queue)).toEqual([0, 0, 0]);
    expect(report.sums).toBeNull();
    expect(enqueueIfAbsent).not.toHaveBeenCalled();
    const sql = execute.mock.calls.map(([query]) => query);
    expect(
      sql.filter((q) => q.includes('FROM owners_balances w'))
    ).toHaveLength(1);
    expect(sql.some((q) => q.includes('FROM nft_owners w'))).toBe(false);
  });

  it('queues the wallets of stale and missing keys, and of a wallet stored under two keys, for the loop of each table', async () => {
    const joined = [A, B, C].join('-');
    const old = [A, B].join('-');
    world({
      holders: [joined],
      active: [D],
      stored: {
        // C joined A and B: the old key is stale, the new one missing.
        nft_owners_consolidation: [old, C],
        // C stored alone and in the group.
        owners_balances_consolidation: [joined, C],
        aggregated_activity_consolidation: [D]
      }
    });

    const report = await sweepHoldingsKeys({ repair: true });

    expect(report.tables).toEqual([
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
    expect(enqueueIfAbsent).toHaveBeenCalledWith([A, B, C], 'owners');
    expect(enqueueIfAbsent).toHaveBeenCalledWith([C], 'balances');
  });

  it('only reports without repair, and then compares the grouped totals', async () => {
    world({
      holders: [A],
      active: [],
      stored: { ...CLEAN_TABLES, nft_owners_consolidation: [B] },
      sums: { compared: 12, differing: 1, wallets: 40, consolidated: 39 }
    });

    const report = await sweepHoldingsKeys({ repair: false });

    expect(report.tables[0]).toMatchObject({
      wallets_to_queue: 2,
      wallets_queued: 0
    });
    expect(report.sums).toEqual({
      nft_tokens_compared: 12,
      nft_tokens_differing: 1,
      wallet_total_balance: 40,
      consolidated_total_balance: 39
    });
    expect(enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it('queues at most 2,000 wallets per loop per sweep', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => wallet(1000 + i));
    world({ holders: many, active: [], stored: CLEAN_TABLES });

    const report = await sweepHoldingsKeys({ repair: true });

    expect(report.tables[0]).toMatchObject({
      missing_keys: 2500,
      wallets_to_queue: 2500,
      wallets_queued: 2000
    });
    expect(enqueueIfAbsent.mock.calls[0][0]).toHaveLength(2000);
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
