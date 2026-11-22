import 'reflect-metadata';
import * as db from '@/db';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE
} from '@/constants';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';
import { consolidateSubscriptions } from './subscriptions';
import {
  REKEY_FALLBACK_INTERVAL_MS,
  rekeyHaltReason,
  rekeyStaleSubscriptions
} from './subscription-rekey-fallback';

// Obviously fake wallets.
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const D = '0x00000000000000000000000000000000000000d4';
const E = '0x00000000000000000000000000000000000000e5';
const AB = `${A}-${B}`;

const T0 = Date.parse('2026-11-25T01:00:00Z');
const MINUTE = 60 * 1000;
/** Limits that let three keys with two stale through. */
const OPEN = { maxStale: 50, maxShare: 1 };

async function balances() {
  return (
    await sqlExecutor.execute<{ consolidation_key: string; balance: number }>(
      `SELECT consolidation_key, balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
        ORDER BY consolidation_key`
    )
  ).map((r) => [r.consolidation_key, Number(r.balance)]);
}

function alerts() {
  return jest
    .spyOn(Logger.prototype, 'errorWithCode')
    .mockImplementation(() => undefined);
}

beforeAll(async () => {
  expect(process.env.DB_HOST).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await db.connect([], false, {
    database: process.env.DB_NAME!,
    failOnInitializationError: true
  });
});

afterAll(async () => {
  if (db.getDataSource()?.isInitialized) await db.disconnect();
});

describeWithSeed(
  'subscriptions re-key fallback',
  [
    // The mirror now groups A and B; the subscriptions are still keyed by
    // each wallet alone, and C is on its own in both.
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        ...[A, B].map((address) => ({ address, consolidation_key: AB })),
        { address: C, consolidation_key: C }
      ]
    },
    withTdhConsolidations([aTdhConsolidation([A, B], { boosted_tdh: 100 })]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: A, balance: 2 },
        { consolidation_key: B, balance: 3 },
        { consolidation_key: C, balance: 1 }
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [
        { consolidation_key: A, automatic: true },
        { consolidation_key: B, automatic: false }
      ]
    }
  ],
  () => {
    it('logs a stale key on one run and re-keys it on the next, as the delegations loop does', async () => {
      const calls: string[][] = [];
      const rekey = async (wallets: Set<string>) => {
        calls.push(Array.from(wallets).sort());
        await consolidateSubscriptions(wallets);
      };
      expect(await rekeyStaleSubscriptions(rekey, T0, OPEN)).toEqual({
        keys: 3,
        stale: 2,
        waiting: 0,
        firstSeen: 2,
        rekeyed: 0,
        wallets: 0,
        stuck: 0,
        halted: null
      });
      expect(calls).toEqual([]);
      // The next run, once due, finds them stale again and re-keys them.
      expect(
        await rekeyStaleSubscriptions(rekey, T0 + 5 * MINUTE, OPEN)
      ).toMatchObject({ stale: 2, firstSeen: 0, rekeyed: 2, wallets: 2 });
      expect(calls).toEqual([[A, B]]);
      expect(await balances()).toEqual([
        [AB, 5],
        [C, 1]
      ]);
      // Nothing is stale any more.
      expect(
        await rekeyStaleSubscriptions(rekey, T0 + 10 * MINUTE, OPEN)
      ).toMatchObject({ stale: 0, rekeyed: 0 });
      expect(calls).toHaveLength(1);
    });

    it('runs by the last run time: not again within the interval, and late runs are made up at once', async () => {
      const rekey = jest.fn();
      expect(await rekeyStaleSubscriptions(rekey, T0, OPEN)).not.toBeNull();
      expect(
        await rekeyStaleSubscriptions(rekey, T0 + MINUTE, OPEN)
      ).toBeNull();
      expect(
        await rekeyStaleSubscriptions(
          rekey,
          T0 + REKEY_FALLBACK_INTERVAL_MS - 1,
          OPEN
        )
      ).toBeNull();
      // A run at 7 minutes past, not on a fifth minute, still goes.
      expect(
        await rekeyStaleSubscriptions(rekey, T0 + 7 * MINUTE, OPEN)
      ).toMatchObject({ rekeyed: 2 });
      expect(rekey).toHaveBeenCalledTimes(1);
    });

    it('skips a wallet with no row in the mirror table, rather than taking it as its own key', async () => {
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:key, 4)`,
        { key: `${D}-${E}` }
      );
      const rekey = jest.fn();
      expect(await rekeyStaleSubscriptions(rekey, T0, OPEN)).toMatchObject({
        keys: 4,
        stale: 2
      });
      await rekeyStaleSubscriptions(rekey, T0 + 5 * MINUTE, OPEN);
      expect(rekey).toHaveBeenCalledWith(new Set([A, B]));
    });

    it('stops above the limits: logs the stale keys, alerts, changes nothing and starts over', async () => {
      const alert = alerts();
      const rekey = jest.fn();
      try {
        // Two of three keys is above 5% of the keys.
        expect(await rekeyStaleSubscriptions(rekey, T0)).toMatchObject({
          stale: 2,
          rekeyed: 0,
          halted: '2 of 3 keys stale, above 5%'
        });
        expect(alert).toHaveBeenCalledWith(
          'SUBSCRIPTIONS_REKEY_HALTED',
          `[REKEY FALLBACK HALTED] 2 of 3 keys stale, above 5%; nothing re-keyed. Stale keys: ${A}, ${B}`
        );
        expect(
          await rekeyStaleSubscriptions(rekey, T0 + 5 * MINUTE, {
            maxStale: 1,
            maxShare: 1
          })
        ).toMatchObject({ halted: '2 stale keys, above the limit of 1' });
        expect(rekey).not.toHaveBeenCalled();
        expect(await balances()).toEqual([
          [A, 2],
          [B, 3],
          [C, 1]
        ]);
        // Below the limits again, each key is seen once before it changes.
        expect(
          await rekeyStaleSubscriptions(rekey, T0 + 10 * MINUTE, OPEN)
        ).toMatchObject({ firstSeen: 2, rekeyed: 0 });
        expect(rekey).not.toHaveBeenCalled();
      } finally {
        alert.mockRestore();
      }
    });

    it('alerts a key that stays stale after three re-keys', async () => {
      const alert = alerts();
      // A re-key that fails to move anything.
      const rekey = jest.fn();
      try {
        const stuck: number[] = [];
        for (let run = 0; run < 5; run++) {
          const result = await rekeyStaleSubscriptions(
            rekey,
            T0 + run * 5 * MINUTE,
            OPEN
          );
          stuck.push(result!.stuck);
        }
        // Seen on run 1, re-keyed on runs 2, 3 and 4, still stale on run 5.
        expect(rekey).toHaveBeenCalledTimes(4);
        expect(stuck).toEqual([0, 0, 0, 0, 2]);
        expect(
          alert.mock.calls.filter(
            ([code]) => code === 'SUBSCRIPTIONS_REKEY_STUCK'
          )
        ).toEqual([
          [
            'SUBSCRIPTIONS_REKEY_STUCK',
            `[REKEY FALLBACK STUCK] still stale after re-keys: ${A} (3 re-keys), ${B} (3 re-keys)`
          ]
        ]);
      } finally {
        alert.mockRestore();
      }
    });

    it("leaves a key whose re-key the key-width guard holds back to the guard's replay", async () => {
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
          (kind, consolidation_key, key_hash, key_length, dedupe_key, payload, reason, created_at)
          VALUES ('CONSOLIDATION', :ab, SHA2(:ab, 256), :len, SHA2(:dedupe, 256), :payload, 'KEY_TOO_WIDE', 0)`,
        {
          ab: AB,
          len: AB.length,
          dedupe: `${AB}|${A},${B}`,
          payload: JSON.stringify({ newKey: AB, oldKeys: [A, B] })
        }
      );
      const rekey = jest.fn();
      for (const at of [T0, T0 + 5 * MINUTE]) {
        expect(await rekeyStaleSubscriptions(rekey, at, OPEN)).toMatchObject({
          stale: 2,
          waiting: 2,
          firstSeen: 0,
          rekeyed: 0
        });
      }
      expect(rekey).not.toHaveBeenCalled();
    });
  }
);

describe('rekeyHaltReason', () => {
  const limits = { maxStale: 50, maxShare: 0.05 };

  it('stops above 50 stale keys, or above 5% of the keys', () => {
    expect(rekeyHaltReason(50, 10_000, limits)).toBeNull();
    expect(rekeyHaltReason(51, 10_000, limits)).toBe(
      '51 stale keys, above the limit of 50'
    );
    expect(rekeyHaltReason(5, 100, limits)).toBeNull();
    expect(rekeyHaltReason(6, 100, limits)).toBe(
      '6 of 100 keys stale, above 5%'
    );
    expect(rekeyHaltReason(0, 0, limits)).toBeNull();
  });
});
