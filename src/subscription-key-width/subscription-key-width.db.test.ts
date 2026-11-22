import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE,
  SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
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
import { TransactionsProcessedSubscriptionsBlock } from '@/entities/ITransactionsProcessing';
import { sqlExecutor } from '@/sql-executor';
import { markSubscriptionCoverageDirty } from '@/subscription-coverage/subscription-coverage-dirty';
import {
  updateSubscription,
  updateSubscriptionMode
} from '@/api/subscriptions/api.subscriptions.db';
import {
  persistNFTFinalSubscriptions,
  persistSubscriptions,
  splitFinalList
} from '@/subscriptionsDaily/db.subscriptions';
import { consolidateSubscriptions } from '@/subscriptionsDaily/subscriptions';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  processAirdrop,
  redeemSubscriptions
} from '@/transactionsProcessingLoop/subscriptions';
import { replayTopUpLoopDeferredWrites } from './subscription-deferred-replay';
import {
  claimDeferredWrite,
  deferSubscriptionWrites,
  executorSink,
  replayDeferredSubscriptionWrites
} from './subscription-deferred-writes';
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
const keyOf = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => wallet(from + i)).join('-');
/** Five wallets: 214 characters, more than the pre-migration 200. */
const LONG_KEY = keyOf(5);
/** Fourteen wallets: 601 characters, more than subscriptions_redeemed's 567. */
const KEY_14 = keyOf(14, 0x20);
const SHORT_KEY = wallet(9);
const AIRDROP = wallet(0xa1);
const CARD = 900;
const BLOCK = 100;

/** The pre-migration width of every key column. */
const OLD_WIDTH = 200;
/** The key-width migration's widths. */
const MIGRATED: Array<[string, number]> = [
  [SUBSCRIPTIONS_BALANCES_TABLE, 700],
  [SUBSCRIPTIONS_MODE_TABLE, 700],
  [SUBSCRIPTIONS_LOGS_TABLE, 700],
  [SUBSCRIPTIONS_NFTS_TABLE, 666],
  [SUBSCRIPTIONS_NFTS_FINAL_TABLE, 666],
  [SUBSCRIPTIONS_REDEEMED_TABLE, 567],
  [SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE, 700],
  [SUBSCRIPTION_COVERAGE_ALERT_STATES_TABLE, 700],
  [ADDRESS_CONSOLIDATION_KEY, 700]
];

async function setWidth(table: string, width: number) {
  await sqlExecutor.execute(
    `ALTER TABLE ${table} MODIFY consolidation_key VARCHAR(${width}) NOT NULL`
  );
  subscriptionKeyWidths.invalidate();
}

/** Each table's width as the schema was synced, restored after each test. */
let schemaWidths: Map<string, number> | null = null;

/** Every test starts from the pre-migration widths, whatever the schema. */
async function startAtOldWidths() {
  if (!schemaWidths) {
    schemaWidths = new Map();
    for (const [table] of MIGRATED) {
      const rows = await sqlExecutor.execute<{ width: number }>(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS width FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table
            AND COLUMN_NAME = 'consolidation_key'`,
        { table }
      );
      schemaWidths.set(table, Number(rows[0].width));
    }
  }
  for (const [table] of MIGRATED) {
    await setWidth(table, OLD_WIDTH);
  }
}

/** Runs after each test's reset, while the test's pool is still open. */
async function restoreSchemaWidths() {
  for (const [table, width] of Array.from(schemaWidths ?? new Map())) {
    await setWidth(table, width);
  }
}

async function migrate(...tables: string[]) {
  for (const [table, width] of MIGRATED) {
    if (tables.length === 0 || tables.includes(table)) {
      await setWidth(table, width);
    }
  }
}

async function queue() {
  return sqlExecutor.execute<{
    sequence: number;
    kind: string;
    consolidation_key: string;
    reason: string;
    replayed_at: number | null;
    outcome: string | null;
  }>(
    `SELECT sequence, kind, consolidation_key, reason, replayed_at, outcome
       FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} ORDER BY sequence`
  );
}

async function keysIn(table: string): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
    `SELECT consolidation_key FROM ${table} ORDER BY consolidation_key`
  );
  return rows.map((r) => r.consolidation_key);
}

async function balanceOf(key: string): Promise<number | null> {
  const rows = await sqlExecutor.execute<{ balance: number }>(
    `SELECT balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE} WHERE consolidation_key = :key`,
    { key }
  );
  return rows.length ? Number(rows[0].balance) : null;
}

async function setBalance(key: string, balance: number) {
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:key, :balance)`,
    { key, balance }
  );
}

function finalRow(key: string): NFTFinalSubscription {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: CARD,
    subscribed_count: 1,
    airdrop_address: key === SHORT_KEY ? key : AIRDROP,
    balance: 1,
    subscribed_at: '2026-11-01T00:00:00.000Z',
    phase: null,
    phase_subscriptions: -1,
    phase_position: -1,
    redeemed_count: 0
  };
}

function autoRow(key: string): NFTSubscription {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: CARD,
    subscribed: true,
    subscribed_count: 1,
    automatic_subscription: true
  };
}

const logLine = (key: string, text: string): SubscriptionLog => ({
  consolidation_key: key,
  log: text
});
const log = (key: string) => logLine(key, 'Added');

const upload: NFTFinalSubscriptionUpload = {
  contract: MEMES_CONTRACT,
  token_id: CARD,
  date: '2026-11-25',
  upload_url: 'x'
};

async function buildFinalList(keys: string[]) {
  const split = await splitFinalList(
    keys.map((key) => finalRow(key)),
    keys.map((key) => log(key))
  );
  await persistNFTFinalSubscriptions(MEMES_CONTRACT, CARD, upload, split);
  return split;
}

/** One airdrop of the upcoming card to SHORT_KEY, as the chain recorded it. */
const airdrop = {
  transaction: '0x' + 'ab'.repeat(32),
  block: BLOCK,
  transaction_date: new Date('2026-11-25T15:00:00Z'),
  from_address: NULL_ADDRESS,
  to_address: SHORT_KEY,
  contract: MEMES_CONTRACT,
  token_id: CARD,
  token_count: 1,
  value: 0
} as Transaction;

async function recordAirdropOnChain(cursorBlock: number) {
  await sqlExecutor.execute(
    `INSERT INTO ${TRANSACTIONS_TABLE}
      (created_at, transaction, block, transaction_date, from_address, to_address,
       contract, token_id, token_count, value, primary_proceeds, royalties,
       gas_gwei, gas_price, gas_price_gwei, gas)
      VALUES (NOW(), :transaction, :block, :date, :from, :to, :contract, :token,
       1, 0, 0, 0, 0, 0, 0, 0)`,
    {
      transaction: airdrop.transaction,
      block: airdrop.block,
      date: airdrop.transaction_date,
      from: airdrop.from_address,
      to: airdrop.to_address,
      contract: airdrop.contract,
      token: airdrop.token_id
    }
  );
  await sqlExecutor.execute(
    `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      VALUES (NOW(), :block, 0)`,
    { block: cursorBlock }
  );
}

/** A final-list subscriber whose key has an earlier write waiting. */
async function seedSubscriberWithEarlierWrite() {
  await setBalance(SHORT_KEY, 1);
  await getDataSource()
    .getRepository(NFTFinalSubscription)
    .save(finalRow(SHORT_KEY));
  await deferSubscriptionWrites(
    [
      {
        kind: 'LOG',
        consolidationKey: SHORT_KEY,
        dedupe: 'earlier',
        payload: { consolidation_key: SHORT_KEY, log: 'Earlier' },
        reason: { narrow: [], pendingEarlier: true }
      }
    ],
    executorSink()
  );
}

async function redeemedCount(): Promise<number> {
  const rows = await sqlExecutor.execute<{ total: number | null }>(
    `SELECT SUM(count) AS total FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
  );
  return Number(rows[0].total ?? 0);
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
    SubscriptionTopUpLatestBlock,
    Transaction,
    TransactionsProcessedSubscriptionsBlock
  ]);
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed(
  'subscription key width guard',
  [],
  () => {
    afterEach(() => {
      delete process.env.FEATURE_SUBSCRIPTION_DEFERRED_REPLAY;
    });

    it('reads each table width from the catalogue', async () => {
      expect(
        await subscriptionKeyWidths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)
      ).toBe(OLD_WIDTH);
      await migrate(SUBSCRIPTIONS_NFTS_TABLE);
      expect(
        await subscriptionKeyWidths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)
      ).toBe(666);
    });

    it('after the migration, holds back a 14-wallet identity whole: no list row, no log, not in the published list', async () => {
      await migrate();
      const split = await buildFinalList([SHORT_KEY, KEY_14]);

      // The published file is built from split.rows.
      expect(split.rows.map((r) => r.consolidation_key)).toEqual([SHORT_KEY]);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE)).toEqual([SHORT_KEY]);
      expect(await keysIn(SUBSCRIPTIONS_LOGS_TABLE)).toEqual([SHORT_KEY]);
      const queued = await queue();
      expect(queued.map((q) => [q.kind, q.consolidation_key])).toEqual([
        ['FINAL_ROW', KEY_14],
        ['LOG', KEY_14]
      ]);
      expect(queued[0].reason).toBe(
        `key of 601 characters; ${SUBSCRIPTIONS_REDEEMED_TABLE} holds 567`
      );

      await persistSubscriptions([autoRow(SHORT_KEY), autoRow(KEY_14)], []);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([SHORT_KEY]);
    });

    it('queues a re-run of the same build once', async () => {
      await buildFinalList([SHORT_KEY, LONG_KEY]);
      await buildFinalList([SHORT_KEY, LONG_KEY]);
      expect((await queue()).map((q) => q.kind)).toEqual(['FINAL_ROW', 'LOG']);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE)).toEqual([SHORT_KEY]);
    });

    it('refuses a change for an identity too wide for every table, saying how many wallets fit', async () => {
      await migrate();
      const message =
        'Subscriptions for identities with more than 13 wallets resume after the identity switch.';
      await expect(
        updateSubscription(KEY_14, MEMES_CONTRACT, CARD, true)
      ).rejects.toThrow(message);
      await expect(updateSubscriptionMode(KEY_14, true)).rejects.toThrow(
        message
      );
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([]);
      expect(await keysIn(SUBSCRIPTIONS_MODE_TABLE)).toEqual([]);
      expect(await queue()).toEqual([]);
    });

    it('keeps a key in order: once it fits, its new writes wait behind its earlier ones, then replay in order, once', async () => {
      await buildFinalList([LONG_KEY]);
      await migrate();

      // The key fits now, but its final row and log line are still queued.
      await persistSubscriptions(
        [autoRow(LONG_KEY)],
        [logLine(LONG_KEY, 'Auto-subscribed')]
      );
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([]);
      await setBalance(LONG_KEY, 1);
      await expect(
        updateSubscription(LONG_KEY, MEMES_CONTRACT, CARD, true)
      ).rejects.toThrow(
        'Subscription changes for this identity resume after the identity switch, after its earlier updates are applied.'
      );
      const queued = await queue();
      expect(queued.map((q) => q.kind)).toEqual([
        'FINAL_ROW',
        'LOG',
        'AUTO_SUBSCRIPTION',
        'LOG'
      ]);
      expect(queued[2].reason).toBe(
        'key of 214 characters; an earlier write for the key is waiting'
      );

      expect(await replayTopUpLoopDeferredWrites()).toEqual({
        done: 4,
        skipped: 0,
        waiting: 0,
        failed: 0
      });
      expect(await replayTopUpLoopDeferredWrites()).toEqual({
        done: 0,
        skipped: 0,
        waiting: 0,
        failed: 0
      });
      expect(await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE)).toEqual([LONG_KEY]);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([LONG_KEY]);
      expect(await keysIn(SUBSCRIPTIONS_LOGS_TABLE)).toEqual([
        LONG_KEY,
        LONG_KEY
      ]);
      expect((await queue()).map((q) => q.outcome)).toEqual([
        'DONE',
        'DONE',
        'DONE',
        'DONE'
      ]);

      // With nothing left waiting, the key takes the normal path.
      await updateSubscription(LONG_KEY, MEMES_CONTRACT, CARD, false);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_TABLE)).toEqual([LONG_KEY]);
    });

    it('claims an entry once, and a replay that fails leaves its entry and the key waiting', async () => {
      await deferSubscriptionWrites(
        [
          {
            kind: 'FINAL_ROW',
            consolidationKey: SHORT_KEY,
            dedupe: 'bad',
            // subscribed_count is an int column: the insert fails.
            payload: { ...finalRow(SHORT_KEY), subscribed_count: 'many' },
            reason: { narrow: [], pendingEarlier: true }
          },
          {
            kind: 'LOG',
            consolidationKey: SHORT_KEY,
            dedupe: 'after',
            payload: log(SHORT_KEY),
            reason: { narrow: [], pendingEarlier: true }
          }
        ],
        executorSink()
      );
      expect(await replayTopUpLoopDeferredWrites()).toEqual({
        done: 0,
        skipped: 0,
        waiting: 1,
        failed: 1
      });
      expect((await queue()).map((q) => q.replayed_at)).toEqual([null, null]);
      expect(await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE)).toEqual([]);
      expect(await keysIn(SUBSCRIPTIONS_LOGS_TABLE)).toEqual([]);

      const [first] = await queue();
      expect(
        await claimDeferredWrite(first.sequence, 'SKIPPED', executorSink())
      ).toBe(true);
      expect(
        await claimDeferredWrite(first.sequence, 'DONE', executorSink())
      ).toBe(false);
      expect((await queue())[0].outcome).toBe('SKIPPED');
    });

    it('pages past entries that cannot be replayed yet', async () => {
      for (const n of [1, 2, 3]) {
        await deferSubscriptionWrites(
          [
            {
              kind: 'LOG',
              consolidationKey: LONG_KEY,
              dedupe: `long-${n}`,
              payload: log(LONG_KEY),
              reason: { narrow: [], pendingEarlier: false }
            }
          ],
          executorSink()
        );
      }
      await deferSubscriptionWrites(
        [
          {
            kind: 'LOG',
            consolidationKey: SHORT_KEY,
            dedupe: 'short',
            payload: log(SHORT_KEY),
            reason: { narrow: [], pendingEarlier: false }
          }
        ],
        executorSink()
      );
      const replayed: number[] = [];
      const summary = await replayDeferredSubscriptionWrites(
        {
          LOG: async (write) => {
            replayed.push(write.sequence);
            return (await claimDeferredWrite(
              write.sequence,
              'DONE',
              executorSink()
            ))
              ? 'DONE'
              : null;
          }
        },
        { pageSize: 1 }
      );
      expect(summary).toEqual({ done: 1, skipped: 0, waiting: 3, failed: 0 });
      expect(replayed).toEqual([(await queue())[3].sequence]);
    });

    it('holds a redemption behind its key’s earlier write and charges it once, in the transactions loop', async () => {
      await seedSubscriberWithEarlierWrite();
      await getDataSource().transaction((em) => processAirdrop(airdrop, em));
      expect(await balanceOf(SHORT_KEY)).toBe(1);
      expect(await redeemedCount()).toBe(0);
      expect((await queue()).map((q) => q.kind)).toEqual(['LOG', 'REDEMPTION']);

      process.env.FEATURE_SUBSCRIPTION_DEFERRED_REPLAY = 'true';
      await recordAirdropOnChain(BLOCK);
      // The earlier log line is replayed by the top-up loop, so the
      // redemption still waits.
      await redeemSubscriptions();
      expect(await balanceOf(SHORT_KEY)).toBe(1);
      // The top-up loop does not replay redemptions.
      expect(await replayTopUpLoopDeferredWrites()).toEqual({
        done: 1,
        skipped: 0,
        waiting: 1,
        failed: 0
      });
      expect(await balanceOf(SHORT_KEY)).toBe(1);

      await redeemSubscriptions();
      await redeemSubscriptions();
      expect(await balanceOf(SHORT_KEY)).toBe(0.93471);
      expect(await redeemedCount()).toBe(1);
      const final = await sqlExecutor.execute<{ redeemed_count: number }>(
        `SELECT redeemed_count FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
      );
      expect(final[0].redeemed_count).toBe(1);
    });

    it('re-derives a lost redemption from the chain: queue emptied, cursor set back, charged once', async () => {
      await seedSubscriberWithEarlierWrite();
      await getDataSource().transaction((em) => processAirdrop(airdrop, em));
      expect(await redeemedCount()).toBe(0);

      // The queue is lost. The airdrop is still in the transactions table;
      // the redemption cursor is set back to the block before it.
      await sqlExecutor.execute(
        `TRUNCATE TABLE ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}`
      );
      await recordAirdropOnChain(BLOCK - 1);
      await redeemSubscriptions();
      await redeemSubscriptions();

      expect(await balanceOf(SHORT_KEY)).toBe(0.93471);
      expect(await redeemedCount()).toBe(1);
    });

    it('queues a consolidation whose new key does not fit, then merges it once on replay', async () => {
      await migrate(ADDRESS_CONSOLIDATION_KEY);
      for (const n of [1, 2, 3, 4, 5]) {
        await sqlExecutor.execute(
          `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:address, :key)`,
          { address: wallet(n), key: LONG_KEY }
        );
      }
      await setBalance(wallet(1), 1);
      await setBalance(wallet(2), 2);
      await consolidateSubscriptions(new Set([wallet(1), wallet(2)]));
      expect(await keysIn(SUBSCRIPTIONS_BALANCES_TABLE)).toEqual([
        wallet(1),
        wallet(2)
      ]);
      expect((await queue()).map((q) => q.kind)).toEqual(['CONSOLIDATION']);

      await migrate();
      expect((await replayTopUpLoopDeferredWrites()).done).toBe(1);
      expect((await replayTopUpLoopDeferredWrites()).done).toBe(0);
      expect(await keysIn(SUBSCRIPTIONS_BALANCES_TABLE)).toEqual([LONG_KEY]);
      expect(await balanceOf(LONG_KEY)).toBe(3);
    });

    it('marks coverage for the keys that fit and skips the one that does not', async () => {
      await markSubscriptionCoverageDirty([SHORT_KEY, LONG_KEY], 'TEST');
      expect(
        await keysIn(SUBSCRIPTION_COVERAGE_REFRESH_REQUESTS_TABLE)
      ).toEqual([SHORT_KEY]);
    });
  },
  { beforeSeed: startAtOldWidths, afterSeed: restoreSchemaWidths }
);
