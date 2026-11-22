import 'reflect-metadata';
import * as db from '@/db';
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
  isRekeyFallbackMinute,
  rekeyStaleSubscriptions
} from './subscription-rekey-fallback';

// Obviously fake wallets.
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const C = '0x00000000000000000000000000000000000000c3';
const AB = `${A}-${B}`;

async function balances() {
  return sqlExecutor.execute<{ consolidation_key: string; balance: number }>(
    `SELECT consolidation_key, balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
      ORDER BY consolidation_key`
  );
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
      rows: [A, B].map((address) => ({ address, consolidation_key: AB }))
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
    it('re-keys the keys the mirror grouped otherwise, as the delegations loop does', async () => {
      const calls: string[][] = [];
      const run = await rekeyStaleSubscriptions(async (wallets) => {
        calls.push(Array.from(wallets).sort());
        await consolidateSubscriptions(wallets);
      });
      expect(run).toEqual({ stale: 2, waiting: 0, wallets: 2 });
      expect(calls).toEqual([[A, B]]);
      expect(
        (await balances()).map((r) => [r.consolidation_key, Number(r.balance)])
      ).toEqual([
        [AB, 5],
        [C, 1]
      ]);
      // Nothing is stale any more, so the next run does nothing.
      const again = jest.fn();
      expect(await rekeyStaleSubscriptions(again)).toEqual({
        stale: 0,
        waiting: 0,
        wallets: 0
      });
      expect(again).not.toHaveBeenCalled();
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
      expect(await rekeyStaleSubscriptions(rekey)).toEqual({
        stale: 2,
        waiting: 2,
        wallets: 0
      });
      expect(rekey).not.toHaveBeenCalled();
    });
  }
);

describe('isRekeyFallbackMinute', () => {
  it('is every fifth minute', () => {
    expect(isRekeyFallbackMinute(new Date('2026-11-25T01:05:30Z'))).toBe(true);
    expect(isRekeyFallbackMinute(new Date('2026-11-25T01:06:00Z'))).toBe(false);
  });
});
