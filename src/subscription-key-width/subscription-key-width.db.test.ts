import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { connect, disconnect, getDataSource } from '@/db';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode,
  SubscriptionTopUp,
  SubscriptionTopUpLatestBlock
} from '@/entities/ISubscription';
import { Transaction } from '@/entities/ITransaction';
import { sqlExecutor } from '@/sql-executor';
import { markSubscriptionCoverageDirty } from '@/subscription-coverage/subscription-coverage-dirty';
import { updateSubscription } from '@/api/subscriptions/api.subscriptions.db';
import {
  persistNFTFinalSubscriptions,
  persistSubscriptions
} from '@/subscriptionsDaily/db.subscriptions';
import { consolidateSubscriptions } from '@/subscriptionsDaily/subscriptions';
import { describeWithSeed } from '@/tests/_setup/seed';
import { processAirdrop } from '@/transactionsProcessingLoop/subscriptions';
import { replayDeferredSubscriptionWritesNow } from './subscription-deferred-replay';
import { subscriptionKeyWidths } from './subscription-key-width';

jest.mock('@/notifier-discord', () => ({ sendDiscordUpdate: jest.fn() }));
jest.mock('@/subscription-wave-notifier', () => ({
  sendProcessedTopUpWaveWarning: jest.fn(),
  sendSubscriptionTopUpWaveUpdate: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: jest.fn(),
  sendNoBalanceFoundWaveError: jest.fn(),
  sendInsufficientBalanceWaveError: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** Five wallets: 214 characters, more than the old 200. */
const LONG_KEY = [1, 2, 3, 4, 5].map(wallet).join('-');
const SHORT_KEY = wallet(9);
const AIRDROP = wallet(0xa1);
const CARD = 900;

const WIDE: Array<[string, number]> = [
  [SUBSCRIPTIONS_BALANCES_TABLE, 700],
  [SUBSCRIPTIONS_MODE_TABLE, 700],
  [SUBSCRIPTIONS_LOGS_TABLE, 700],
  [SUBSCRIPTIONS_NFTS_TABLE, 666],
  [SUBSCRIPTIONS_NFTS_FINAL_TABLE, 666],
  [SUBSCRIPTIONS_REDEEMED_TABLE, 567],
  [ADDRESS_CONSOLIDATION_KEY, 700]
];

async function setWidth(table: string, width: number) {
  await sqlExecutor.execute(
    `ALTER TABLE ${table} MODIFY consolidation_key VARCHAR(${width}) NOT NULL`
  );
  subscriptionKeyWidths.invalidate();
}

const widened = new Set<string>();

async function widen(...tables: string[]) {
  for (const [table, width] of WIDE) {
    if (tables.includes(table)) {
      await setWidth(table, width);
      widened.add(table);
    }
  }
}

async function deferred() {
  return sqlExecutor.execute<{
    kind: string;
    consolidation_key: string;
    replayed_at: number | null;
    outcome: string | null;
  }>(
    `SELECT kind, consolidation_key, replayed_at, outcome
       FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} ORDER BY created_at, kind`
  );
}

async function keysIn(table: string): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
    `SELECT consolidation_key FROM ${table} ORDER BY consolidation_key`
  );
  return rows.map((r) => r.consolidation_key);
}

function finalRow(key: string): NFTFinalSubscription {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: CARD,
    subscribed_count: 1,
    airdrop_address: key === LONG_KEY ? AIRDROP : key,
    balance: 1,
    subscribed_at: '2026-11-01T00:00:00.000Z',
    phase: null,
    phase_subscriptions: -1,
    phase_position: -1,
    redeemed_count: 0
  };
}

beforeAll(async () => {
  await connect([
    SubscriptionBalance,
    SubscriptionTopUp,
    SubscriptionMode,
    SubscriptionLog,
    NFTSubscription,
    NFTFinalSubscription,
    NFTFinalSubscriptionUpload,
    RedeemedSubscription,
    SubscriptionTopUpLatestBlock
  ]);
});

/** Runs after each test's reset, while the test's pool is still open. */
async function restoreWidths() {
  for (const table of Array.from(widened)) {
    await setWidth(table, 200);
  }
  widened.clear();
}

afterAll(async () => {
  await disconnect();
});

describeWithSeed(
  'subscription key width guard',
  [],
  () => {
    it('reads each table width from the catalogue', async () => {
      subscriptionKeyWidths.invalidate();
      expect(
        await subscriptionKeyWidths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)
      ).toBe(200);
      await widen(SUBSCRIPTIONS_NFTS_TABLE);
      expect(
        await subscriptionKeyWidths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)
      ).toBe(666);
    });

    it('writes the rest of a final list and queues the row and log that do not fit', async () => {
      await persistNFTFinalSubscriptions(
        MEMES_CONTRACT,
        CARD,
        {
          contract: MEMES_CONTRACT,
          token_id: CARD,
          date: '2026-11-25',
          upload_url: 'x'
        },
        [finalRow(SHORT_KEY), finalRow(LONG_KEY)],
        [
          { consolidation_key: SHORT_KEY, log: 'Added' },
          { consolidation_key: LONG_KEY, log: 'Added' }
        ]
      );
      expect(await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE)).toEqual([SHORT_KEY]);
      expect(await keysIn(SUBSCRIPTIONS_LOGS_TABLE)).toEqual([SHORT_KEY]);
      expect((await deferred()).map((d) => d.kind).sort()).toEqual([
        'FINAL_ROW',
        'LOG'
      ]);
    });

    it('writes the rest of the automatic rows and queues the one that does not fit', async () => {
      const row = (key: string): NFTSubscription => ({
        consolidation_key: key,
        contract: MEMES_CONTRACT,
        token_id: CARD,
        subscribed: true,
        subscribed_count: 1,
        automatic_subscription: true
      });
      await persistSubscriptions([row(SHORT_KEY), row(LONG_KEY)], []);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([SHORT_KEY]);
      expect((await deferred()).map((d) => d.kind)).toEqual([
        'AUTO_SUBSCRIPTION'
      ]);
    });

    it('queues a subscribe, then replays it once the column is wide enough', async () => {
      await widen(SUBSCRIPTIONS_BALANCES_TABLE);
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:key, 1)`,
        { key: LONG_KEY }
      );
      const response = await updateSubscription(
        LONG_KEY,
        MEMES_CONTRACT,
        CARD,
        true
      );
      expect(response).toEqual(expect.objectContaining({ deferred: true }));
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([]);

      expect((await replayDeferredSubscriptionWritesNow()).waiting).toBe(1);
      await widen(SUBSCRIPTIONS_NFTS_TABLE, SUBSCRIPTIONS_LOGS_TABLE);
      expect(await replayDeferredSubscriptionWritesNow()).toEqual({
        done: 1,
        skipped: 0,
        waiting: 0,
        failed: 0
      });
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([LONG_KEY]);
      expect((await deferred())[0]).toEqual(
        expect.objectContaining({ kind: 'SUBSCRIPTION', outcome: 'DONE' })
      );
    });

    it('defers a redemption whole and redeems it on replay', async () => {
      await widen(SUBSCRIPTIONS_BALANCES_TABLE, SUBSCRIPTIONS_NFTS_FINAL_TABLE);
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:key, 1)`,
        { key: LONG_KEY }
      );
      await getDataSource()
        .getRepository(NFTFinalSubscription)
        .save(finalRow(LONG_KEY));
      const transaction = {
        transaction: '0x' + 'ab'.repeat(32),
        block: 100,
        transaction_date: new Date('2026-11-25T15:00:00Z'),
        from_address: NULL_ADDRESS,
        to_address: AIRDROP,
        contract: MEMES_CONTRACT,
        token_id: CARD,
        token_count: 1,
        value: 0
      } as Transaction;
      await getDataSource().transaction((em) =>
        processAirdrop(transaction, em)
      );

      const balance = await sqlExecutor.execute<{ balance: number }>(
        `SELECT balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
      );
      expect(balance[0].balance).toBe(1);
      expect(await keysIn(SUBSCRIPTIONS_REDEEMED_TABLE)).toEqual([]);
      expect((await deferred()).map((d) => d.kind)).toEqual(['REDEMPTION']);

      await widen(SUBSCRIPTIONS_REDEEMED_TABLE);
      expect((await replayDeferredSubscriptionWritesNow()).done).toBe(1);
      const after = await sqlExecutor.execute<{ balance: number }>(
        `SELECT balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
      );
      expect(after[0].balance).toBe(0.93471);
      expect(await keysIn(SUBSCRIPTIONS_REDEEMED_TABLE)).toEqual([LONG_KEY]);
      const final = await sqlExecutor.execute<{ redeemed_count: number }>(
        `SELECT redeemed_count FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
      );
      expect(final[0].redeemed_count).toBe(1);
    });

    it('queues a consolidation whose new key does not fit and leaves the old keys', async () => {
      await widen(ADDRESS_CONSOLIDATION_KEY);
      for (const n of [1, 2, 3, 4, 5]) {
        await sqlExecutor.execute(
          `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:address, :key)`,
          { address: wallet(n), key: LONG_KEY }
        );
      }
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:a, 1), (:b, 2)`,
        { a: wallet(1), b: wallet(2) }
      );
      await consolidateSubscriptions(new Set([wallet(1), wallet(2)]));
      expect(await keysIn(SUBSCRIPTIONS_BALANCES_TABLE)).toEqual([
        wallet(1),
        wallet(2)
      ]);
      expect((await deferred()).map((d) => d.kind)).toEqual(['CONSOLIDATION']);
    });

    it('marks coverage for the keys that fit and skips the one that does not', async () => {
      await markSubscriptionCoverageDirty([SHORT_KEY, LONG_KEY], 'TEST');
      expect(
        await keysIn(SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE)
      ).toEqual([SHORT_KEY]);
    });
  },
  { beforeSeed: async () => undefined, afterSeed: restoreWidths }
);
