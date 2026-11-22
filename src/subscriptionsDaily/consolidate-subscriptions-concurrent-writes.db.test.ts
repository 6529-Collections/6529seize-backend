import 'reflect-metadata';
import * as db from '@/db';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';
import { persistTopUps } from '@/subscriptionsTopUpLoop/db.subscriptions_topup';
import { processAirdrop } from '@/transactionsProcessingLoop/subscriptions';
import { consolidateSubscriptions } from './subscriptions';

// Notices and cache work that follow a top-up or charge, not under test.
jest.mock('@/notifier-discord', () => ({ sendDiscordUpdate: jest.fn() }));
jest.mock('@/subscription-wave-notifier', () => ({
  sendProcessedTopUpWaveWarning: jest.fn(),
  sendSubscriptionTopUpWaveUpdate: jest.fn(),
  sendInsufficientBalanceWaveError: jest.fn(),
  sendNoBalanceFoundWaveError: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: jest.fn()
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirty: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

// Wallets A and B consolidate into AB, which already has a balance.
const A = '0xa';
const B = '0xb';
const AB = `${A}-${B}`;
const C = '0xc';
const D = '0xd';
const E = '0xe';
const CARD = 700;
const AIRDROP = '0x' + 'e'.repeat(64);

/**
 * The PR text's read-only check: per balance, the top-ups from the wallets
 * in its key less the charges recorded under it, where the two differ by
 * 0.001 ETH or more. Table names come from the constants.
 */
const BALANCE_VS_LEDGER = `
  SELECT b.consolidation_key, b.balance,
         COALESCE(t.topped_up, 0) AS topped_up,
         COALESCE(r.charged, 0) AS charged,
         b.balance - COALESCE(t.topped_up, 0) + COALESCE(r.charged, 0)
           AS difference
    FROM ${SUBSCRIPTIONS_BALANCES_TABLE} b
    LEFT JOIN (
      SELECT k.consolidation_key, SUM(u.amount) AS topped_up
        FROM ${SUBSCRIPTIONS_BALANCES_TABLE} k
        JOIN ${SUBSCRIPTIONS_TOP_UP_TABLE} u
          ON FIND_IN_SET(LOWER(u.from_wallet),
               REPLACE(LOWER(k.consolidation_key), '-', ',')) > 0
       GROUP BY k.consolidation_key
    ) t ON t.consolidation_key = b.consolidation_key
    LEFT JOIN (
      SELECT consolidation_key, SUM(value) AS charged
        FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
       GROUP BY consolidation_key
    ) r ON r.consolidation_key = b.consolidation_key
   WHERE ABS(b.balance - COALESCE(t.topped_up, 0) + COALESCE(r.charged, 0))
         >= 0.001
   ORDER BY b.consolidation_key`;

// The merge's read of the final allocations is its transaction's first
// plain read, so it fixes the snapshot that every later plain read returns.
const FINAL_CONFLICT_READ = new RegExp(
  String.raw`FROM\s+${SUBSCRIPTIONS_NFTS_FINAL_TABLE}\s+merged\b`
);

/**
 * Merges A and B into AB. Just after the merge's snapshot is taken, `write`
 * runs to its commit on another connection; then the merge goes on.
 */
async function mergeWithWriteAfterSnapshot(write: () => Promise<unknown>) {
  const source = db.getDataSource();
  const createRunner = source.createQueryRunner.bind(source);
  let wrote = false;
  const factory = jest
    .spyOn(source, 'createQueryRunner')
    .mockImplementation((mode) => {
      const runner = createRunner(mode);
      // Every argument passes through: TypeORM's query builders ask for a
      // structured result with the third.
      const query = runner.query.bind(runner) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      jest.spyOn(runner, 'query').mockImplementation((async (
        ...args: unknown[]
      ) => {
        const result = await query(...args);
        if (!wrote && FINAL_CONFLICT_READ.test(String(args[0]))) {
          wrote = true;
          await write();
        }
        return result;
      }) as never);
      return runner;
    });
  try {
    await consolidateSubscriptions(new Set([A, B]));
  } finally {
    factory.mockRestore();
  }
  expect(wrote).toBe(true);
}

/** The top-up loop's own transaction: a TypeORM query runner, as in production. */
function topUp(amount: number) {
  const run = jest
    .spyOn(sqlExecutor, 'executeNativeQueriesInTransaction')
    .mockImplementation((executable) =>
      db
        .getDataSource()
        .transaction((manager) =>
          executable({ connection: manager.queryRunner! })
        )
    );
  return persistTopUps([
    {
      hash: '0x' + 'f'.repeat(64),
      block: 1,
      transaction_date: new Date('2026-11-20T00:00:00Z'),
      from_wallet: A,
      amount
    }
  ]).finally(() => run.mockRestore());
}

/** The transactions processing loop charging one airdrop to wallet A. */
function charge() {
  const drop = {
    created_at: new Date(),
    transaction: AIRDROP,
    block: 1,
    transaction_date: new Date('2026-11-20T00:00:00Z'),
    from_address: NULL_ADDRESS,
    to_address: A,
    contract: MEMES_CONTRACT.toLowerCase(),
    token_id: CARD,
    token_count: 1,
    value: 0
  } as Transaction;
  return db
    .getDataSource()
    .transaction((manager) => processAirdrop(drop, manager));
}

async function balances() {
  const rows = await sqlExecutor.execute<{
    consolidation_key: string;
    balance: number;
  }>(
    `SELECT consolidation_key, balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
     ORDER BY consolidation_key`
  );
  return rows.map((row) => [row.consolidation_key, Number(row.balance)]);
}

/** [key, balance, topped_up, charged, difference] per row. */
async function balanceVsLedger() {
  const rows =
    await sqlExecutor.execute<Record<string, string>>(BALANCE_VS_LEDGER);
  return rows.map((row) => [
    row.consolidation_key,
    Number(row.balance),
    Number(row.topped_up),
    Number(row.charged),
    Math.round(Number(row.difference) * 100000) / 100000
  ]);
}

function toppedUp(hash: string, wallet: string, amount: number) {
  return {
    hash,
    block: 1,
    transaction_date: new Date('2026-11-19T00:00:00Z'),
    from_wallet: wallet,
    amount
  };
}

beforeAll(async () => {
  expect(process.env.DB_HOST).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(process.env.DB_NAME).toMatch(/_jest_worker_\d+$/);
  expect(Number(process.env.DB_PORT)).not.toBe(3306);
  // The top-up and the charge write through TypeORM repositories.
  await db.connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never,
    false,
    { database: process.env.DB_NAME!, failOnInitializationError: true }
  );
});

afterAll(async () => {
  if (db.getDataSource()?.isInitialized) await db.disconnect();
});

describeWithSeed(
  'Real MySQL: a top-up or charge committed during a merge',
  [
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
        { consolidation_key: AB, balance: 7 }
      ]
    },
    {
      // The top-ups behind those balances. AB's 7 came from wallet A after
      // it joined AB.
      table: SUBSCRIPTIONS_TOP_UP_TABLE,
      rows: [
        toppedUp('0x' + '1'.repeat(64), A, 2),
        toppedUp('0x' + '2'.repeat(64), B, 3),
        toppedUp('0x' + '3'.repeat(64), A, 7)
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [A, B, AB].map((key) => ({
        consolidation_key: key,
        automatic: false
      }))
    },
    {
      // AB's one edition of the card, airdropped to wallet A.
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [
        {
          consolidation_key: AB,
          contract: MEMES_CONTRACT,
          token_id: CARD,
          subscribed_count: 1,
          airdrop_address: A,
          balance: 7,
          subscribed_at: '2026-11-20 00:00:00',
          phase: 'Phase 1',
          phase_subscriptions: 1,
          phase_position: 1,
          redeemed_count: 0
        }
      ]
    }
  ],
  () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('keeps a top-up committed after the merge took its snapshot', async () => {
      // The top-up from wallet A goes to AB, the key A now belongs to.
      await mergeWithWriteAfterSnapshot(() => topUp(1));

      // 2 + 3 + 7, and the top-up of 1. Without the lock: 12.
      expect(await balances()).toEqual([[AB, 13]]);
      expect(await balanceVsLedger()).toEqual([]);
    });

    it('keeps a charge committed after the merge took its snapshot', async () => {
      await mergeWithWriteAfterSnapshot(() => charge());

      const [[key, balance], ...rest] = await balances();
      expect(rest).toEqual([]);
      expect(key).toBe(AB);
      // 2 + 3 + 7, less one mint price. Without the lock: 12.
      expect(balance).toBeCloseTo(12 - MEMES_MINT_PRICE, 10);
      const redeemed = await sqlExecutor.execute<{ consolidation_key: string }>(
        `SELECT consolidation_key FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
      );
      expect(redeemed).toEqual([{ consolidation_key: AB }]);
      expect(await balanceVsLedger()).toEqual([]);
    });

    it('keeps a mode switched on after the merge took its snapshot', async () => {
      await mergeWithWriteAfterSnapshot(() =>
        sqlExecutor.execute(
          `UPDATE ${SUBSCRIPTIONS_MODE_TABLE} SET automatic = true
            WHERE consolidation_key = :key`,
          { key: B }
        )
      );

      const [mode] = await sqlExecutor.execute<{ automatic: number }>(
        `SELECT automatic FROM ${SUBSCRIPTIONS_MODE_TABLE}
          WHERE consolidation_key = :key`,
        { key: AB }
      );
      expect(Boolean(mode.automatic)).toBe(true);
    });
  }
);

// Balances as the merge left them before the lock: C lost a top-up of 1,
// D-E lost a charge. AB is right.
describeWithSeed(
  'Real MySQL: the balance check finds a lost top-up and a lost charge',
  [
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: AB, balance: 12 - MEMES_MINT_PRICE },
        { consolidation_key: C, balance: 2 },
        { consolidation_key: `${D}-${E}`, balance: 1 }
      ]
    },
    {
      table: SUBSCRIPTIONS_TOP_UP_TABLE,
      rows: [
        toppedUp('0x' + '1'.repeat(64), A, 5),
        toppedUp('0x' + '2'.repeat(64), B.toUpperCase(), 7),
        toppedUp('0x' + '3'.repeat(64), C, 2),
        toppedUp('0x' + '4'.repeat(64), C, 1),
        toppedUp('0x' + '5'.repeat(64), E, 1)
      ]
    },
    {
      table: SUBSCRIPTIONS_REDEEMED_TABLE,
      rows: [AB, `${D}-${E}`].map((key) => ({
        contract: MEMES_CONTRACT,
        token_id: CARD,
        address: key,
        transaction: `test-${key}`,
        consolidation_key: key,
        value: MEMES_MINT_PRICE,
        balance_after: 0,
        count: 1
      }))
    }
  ],
  () => {
    it('lists the two balances that differ from their top-ups less charges', async () => {
      expect(await balanceVsLedger()).toEqual([
        [C, 2, 3, 0, -1],
        [`${D}-${E}`, 1, 1, MEMES_MINT_PRICE, MEMES_MINT_PRICE]
      ]);
    });
  }
);
