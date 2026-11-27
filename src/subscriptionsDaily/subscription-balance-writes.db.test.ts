import 'reflect-metadata';
import { FindOneOptions, Repository } from 'typeorm';
import * as db from '@/db';
import { DbQueryOptions } from '@/db-query.options';
import * as Entities from '@/entities/entities';
import { SubscriptionBalance } from '@/entities/ISubscription';
import { Transaction } from '@/entities/ITransaction';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import {
  deferSubscriptionWrites,
  executorSink
} from '@/subscription-key-width/subscription-deferred-writes';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE
} from '@/constants';
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

// Obviously fake wallets. A and B consolidate into AB.
const A = '0xa';
const B = '0xb';
const AB = `${A}-${B}`;
const CARD = 700;
const AIRDROP = '0x' + 'e'.repeat(64);
const TOP_UP = '0x' + 'f'.repeat(64);

/**
 * persistTopUps runs on a TypeORM query runner, and the key-width guard's
 * queue writes go through the SQL executor inside that transaction, as in
 * production. The test harness's executor hands out mysql pool connections,
 * so these tests use one like production's on the test's data source.
 */
class TypeOrmExecutor extends SqlExecutor {
  execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    return db.execSQLWithParams(sql, params, options);
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    const runner = db.getDataSource().createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await executable({ connection: runner });
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}

/**
 * Whether a query runner call is the top-up's key lookup for `wallet`: the
 * read of the consolidation key mapping by one address, with the wallet as
 * its bound parameter. The balance lock's read of the same table (`IN`,
 * FOR SHARE) doesn't match, so a hook never runs while that lock is held.
 */
function looksUpKeyOf(args: unknown[], wallet: string): boolean {
  const [sql, params] = args;
  return (
    String(sql).includes(ADDRESS_CONSOLIDATION_KEY) &&
    /WHERE address = \?/.test(String(sql)) &&
    Array.isArray(params) &&
    params.some((param) => String(param).toLowerCase() === wallet.toLowerCase())
  );
}

/** In a describe body: each test runs on the TypeORM executor. */
function onTypeOrmExecutor() {
  let previous: SqlExecutor;
  beforeEach(() => {
    previous = sqlExecutor;
    setSqlExecutor(new TypeOrmExecutor());
  });
  afterEach(() => {
    jest.restoreAllMocks();
    setSqlExecutor(previous);
  });
}

/** The top-up loop crediting `amount` from wallet A, in its own transaction. */
function topUp(amount: number) {
  return persistTopUps([
    {
      hash: TOP_UP,
      block: 1,
      transaction_date: new Date('2026-11-20T00:00:00Z'),
      from_wallet: A,
      amount
    }
  ]);
}

/** An airdrop of the card to `wallet`. */
function airdropTo(wallet: string): Transaction {
  return {
    created_at: new Date(),
    transaction: AIRDROP,
    block: 1,
    transaction_date: new Date('2026-11-20T00:00:00Z'),
    from_address: NULL_ADDRESS,
    to_address: wallet,
    contract: MEMES_CONTRACT.toLowerCase(),
    token_id: CARD,
    token_count: 1,
    value: 0
  } as Transaction;
}

/** The transactions processing loop charging one airdrop to wallet A. */
function charge() {
  return db
    .getDataSource()
    .transaction((manager) => processAirdrop(airdropTo(A), manager));
}

/** Queues an earlier write for `key`, so the guard holds its next ones back. */
function queueEarlierWrite(key: string) {
  return deferSubscriptionWrites(
    [
      {
        kind: 'LOG',
        consolidationKey: key,
        dedupe: 'earlier',
        payload: { consolidation_key: key, log: 'Earlier' },
        reason: { narrow: [], pendingEarlier: true }
      }
    ],
    executorSink()
  );
}

/** [kind, consolidation_key] of each queued write, in order. */
async function queue() {
  const rows = await sqlExecutor.execute<{
    kind: string;
    consolidation_key: string;
  }>(
    `SELECT kind, consolidation_key FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
      ORDER BY sequence`
  );
  return rows.map((row) => [row.kind, row.consolidation_key]);
}

/**
 * Starts `write` and returns once it has committed or is waiting for a row
 * lock, with its promise, so the caller can let the other transaction go on.
 */
async function startUntilDoneOrWaiting(
  write: () => Promise<unknown>
): Promise<{ done: Promise<unknown> }> {
  let settled = false;
  const done = write().finally(() => {
    settled = true;
  });
  done.catch(() => undefined);
  // MySQL refreshes innodb_trx only when it was last read over 0.1 s ago,
  // so a faster poll keeps reading the same stale rows.
  for (let i = 0; i < 200 && !settled; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const [waiting] = await sqlExecutor.execute<{ count: number }>(
      `SELECT COUNT(*) AS count FROM information_schema.innodb_trx
        WHERE trx_state = 'LOCK WAIT'`
    );
    if (Number(waiting.count) > 0) return { done };
  }
  if (!settled) throw new Error('second writer neither finished nor waited');
  return { done };
}

/**
 * Runs `first`. Right after it reads the balance, `second` starts and runs
 * until it commits or waits for a lock; then `first` goes on. Resolves when
 * both have finished.
 */
async function secondDuringFirst(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>
) {
  const findOne = Repository.prototype.findOne;
  let started: Promise<{ done: Promise<unknown> }> | undefined;
  jest
    .spyOn(Repository.prototype, 'findOne')
    .mockImplementation(async function (
      this: Repository<any>,
      options: FindOneOptions<any>
    ) {
      const result = await findOne.call(this, options);
      // Only the first writer's read: the second one's goes straight through.
      if (!started && this.metadata.target === SubscriptionBalance) {
        started = startUntilDoneOrWaiting(second);
        await started;
      }
      return result;
    });
  await first();
  expect(started).toBeDefined();
  await (
    await started!
  ).done;
}

// The merge's last statement inserts the merged mode row. By then it holds
// its locks on the final allocations, redemptions and balances it moved.
const MERGE_LAST_WRITE = new RegExp(
  String.raw`INSERT\s+INTO\s+${SUBSCRIPTIONS_MODE_TABLE}\b`
);

/**
 * Merges A and B into AB. Before the merge commits, `write` starts and runs
 * until it commits or waits for a lock; then the merge commits. Resolves
 * with the writer's outcome.
 */
async function writeDuringMerge(write: () => Promise<unknown>) {
  const source = db.getDataSource();
  const createRunner = source.createQueryRunner.bind(source);
  let started: Promise<{ done: Promise<unknown> }> | undefined;
  jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
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
      if (!started && MERGE_LAST_WRITE.test(String(args[0]))) {
        started = startUntilDoneOrWaiting(write);
        await started;
      }
      return result;
    }) as never);
    return runner;
  });
  await consolidateSubscriptions(new Set([A, B]));
  expect(started).toBeDefined();
  return (await started!).done;
}

/**
 * The PR text's read-only check: balances under a key whose wallets all
 * belong to one other key now, as a merge before these locks could leave
 * them. Keys of up to 16 wallets. Table names come from the constants.
 */
const BALANCES_UNDER_A_MERGED_KEY = `
  WITH RECURSIVE positions (n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM positions WHERE n < 16
  )
  SELECT b.consolidation_key, b.balance,
         MAX(m.consolidation_key) AS current_key
    FROM ${SUBSCRIPTIONS_BALANCES_TABLE} b
    JOIN positions i
      ON i.n <= 1 + LENGTH(b.consolidation_key)
                  - LENGTH(REPLACE(b.consolidation_key, '-', ''))
    JOIN ${ADDRESS_CONSOLIDATION_KEY} m
      ON m.address = SUBSTRING_INDEX(
           SUBSTRING_INDEX(b.consolidation_key, '-', i.n), '-', -1)
   GROUP BY b.consolidation_key, b.balance
  HAVING COUNT(DISTINCT m.consolidation_key) = 1
     AND MAX(m.consolidation_key) <> b.consolidation_key
   ORDER BY b.consolidation_key`;

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

async function redemptionKeys() {
  const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
    `SELECT consolidation_key FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`
  );
  return rows.map((row) => row.consolidation_key);
}

function finalAllocation(key: string): Record<string, unknown> {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: CARD,
    subscribed_count: 1,
    airdrop_address: A,
    balance: 1,
    subscribed_at: '2026-11-20 00:00:00',
    phase: 'Phase 1',
    phase_subscriptions: 1,
    phase_position: 1,
    redeemed_count: 0
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
  'Real MySQL: a top-up and a charge on one balance at once',
  [
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: A, balance: 1 }]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [{ consolidation_key: A, automatic: true }]
    },
    { table: SUBSCRIPTIONS_NFTS_FINAL_TABLE, rows: [finalAllocation(A)] }
  ],
  () => {
    onTypeOrmExecutor();

    it('keeps a top-up made while a charge holds the balance', async () => {
      await secondDuringFirst(charge, () => topUp(0.5));

      // 1 - 0.06529 + 0.5. Without the locks the top-up is lost: 0.93471.
      const [[key, balance]] = await balances();
      expect(key).toBe(A);
      expect(balance).toBeCloseTo(1.43471, 10);
    });

    it('keeps a charge made while a top-up holds the balance', async () => {
      await secondDuringFirst(() => topUp(0.5), charge);

      // Without the locks the charge is lost: 1.5.
      const [[key, balance]] = await balances();
      expect(key).toBe(A);
      expect(balance).toBeCloseTo(1.43471, 10);
      expect(await redemptionKeys()).toEqual([A]);
    });
  }
);

function mergeSeeds(destinationBalance: boolean): Seed[] {
  return [
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
        ...(destinationBalance ? [{ consolidation_key: AB, balance: 7 }] : [])
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [A, B].map((key) => ({ consolidation_key: key, automatic: true }))
    },
    // A's edition of the card, which the merge moves to AB.
    { table: SUBSCRIPTIONS_NFTS_FINAL_TABLE, rows: [finalAllocation(A)] }
  ];
}

describeWithSeed(
  'Real MySQL: a writer that reads during a merge',
  mergeSeeds(true),
  () => {
    onTypeOrmExecutor();

    it('adds a top-up to the merged balance', async () => {
      await writeDuringMerge(() => topUp(1));

      // 2 + 3 + 7 + 1. Without the locks the top-up overwrites the merged
      // balance with 7 + 1.
      expect(await balances()).toEqual([[AB, 13]]);
      const [topUpRow] = await sqlExecutor.execute<{ hash: string }>(
        `SELECT hash FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
      );
      expect(topUpRow.hash).toBe(TOP_UP);
    });

    it('takes a charge from the merged balance', async () => {
      await writeDuringMerge(charge);

      // Without the locks the charge goes to A's deleted row and is lost:
      // AB stays 12, and the redemption is recorded under A.
      const [[key, balance], ...rest] = await balances();
      expect(rest).toEqual([]);
      expect(key).toBe(AB);
      expect(balance).toBeCloseTo(12 - MEMES_MINT_PRICE, 10);
      expect(await redemptionKeys()).toEqual([AB]);
      const [allocation] = await sqlExecutor.execute<{
        consolidation_key: string;
        redeemed_count: number;
      }>(
        `SELECT consolidation_key, redeemed_count
           FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
      );
      expect(allocation).toEqual({ consolidation_key: AB, redeemed_count: 1 });
    });
  }
);

describeWithSeed(
  'Real MySQL: a writer that reads during a merge into a new key',
  mergeSeeds(false),
  () => {
    onTypeOrmExecutor();

    it('adds a top-up to the balance the merge created', async () => {
      // Without the locks the top-up finds no AB row, tries to insert one
      // after the merge has, and fails on the duplicate key.
      await writeDuringMerge(() => topUp(1));

      expect(await balances()).toEqual([[AB, 6]]);
    });
  }
);

// The address-to-key mapping still says A when the top-up reads it; a merge
// of A and B into AB commits before the top-up locks A's balance.
describeWithSeed(
  'Real MySQL: a top-up whose key a merge moved after it was read',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [A, B].map((address) => ({ address, consolidation_key: address }))
    },
    withTdhConsolidations([aTdhConsolidation([A, B], { boosted_tdh: 100 })]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: A, balance: 2 },
        { consolidation_key: B, balance: 3 }
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [A, B].map((key) => ({ consolidation_key: key, automatic: true }))
    }
  ],
  () => {
    onTypeOrmExecutor();

    /**
     * Tops up 0.05 from A. Right after the top-up reads A's key, the
     * wallets consolidate, the merge runs and commits, and then `afterMerge`
     * runs.
     */
    async function topUpWhileTheKeyMoves(afterMerge?: () => Promise<unknown>) {
      const source = db.getDataSource();
      const createRunner = source.createQueryRunner.bind(source);
      let merged = false;
      jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
        const runner = createRunner(mode);
        const query = runner.query.bind(runner) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        jest.spyOn(runner, 'query').mockImplementation((async (
          ...args: unknown[]
        ) => {
          const result = await query(...args);
          if (!merged && looksUpKeyOf(args, A)) {
            merged = true;
            await sqlExecutor.execute(
              `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = :key`,
              { key: AB }
            );
            await consolidateSubscriptions(new Set([A, B]));
            await afterMerge?.();
          }
          return result;
        }) as never);
        return runner;
      });

      // Below the mint price, so a top-up taken for A's first one does not
      // also switch A's mode.
      await topUp(0.05);
      expect(merged).toBe(true);
    }

    it('credits the key the merge moved the balance to', async () => {
      await topUpWhileTheKeyMoves();

      // 2 + 3 + 0.05. Without following the move, the top-up recreates A
      // with 0.05 (or, before the locks, updates A's deleted row and is lost).
      expect(await balances()).toEqual([[AB, 5.05]]);
      expect(await sqlExecutor.execute(BALANCES_UNDER_A_MERGED_KEY)).toEqual(
        []
      );
    });
  }
);

// The sender is a value in the key lookup, never SQL text. Written into the
// query, a quote in it would end the string, and the rest would match every
// mapped address: the top-up would credit whichever key came back first.
describeWithSeed(
  'Real MySQL: the top-up key lookup takes the sender as a value',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [{ address: B, consolidation_key: B }]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: B, balance: 3 }]
    }
  ],
  () => {
    onTypeOrmExecutor();

    it('credits a sender with a quote in it under its own key, not a mapped one', async () => {
      const sender = `${A}' OR '1'='1`;
      await persistTopUps([
        {
          hash: TOP_UP,
          block: 1,
          transaction_date: new Date('2026-11-20T00:00:00Z'),
          from_wallet: sender,
          amount: 1
        }
      ]);

      // No mapping holds the sender, so it is its own key. B keeps its 3.
      expect(await balances()).toEqual([
        [sender, 1],
        [B, 3]
      ]);
      // The top-up row and the automatic mode a first top-up turns on are
      // the sender's too.
      expect(
        await sqlExecutor.execute(
          `SELECT from_wallet FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
        )
      ).toEqual([{ from_wallet: sender }]);
      expect(
        await sqlExecutor.execute(
          `SELECT consolidation_key FROM ${SUBSCRIPTIONS_MODE_TABLE}`
        )
      ).toEqual([{ consolidation_key: sender }]);
    });
  }
);

// Fourteen full-length wallets: a key of 601 characters. The mapping and the
// balance table hold it; the redemption table holds 567, thirteen wallets.
// Its first wallet tops up for the first time.
const WIDE_WALLETS = Array.from(
  { length: 14 },
  (_, n) => `0x${(n + 1).toString(16).padStart(40, '0')}`
);
const WIDE_KEY = WIDE_WALLETS.join('-');

describeWithSeed(
  'Real MySQL: a top-up whose key moves to one the tables cannot hold',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [{ address: WIDE_WALLETS[0], consolidation_key: WIDE_WALLETS[0] }]
    }
  ],
  () => {
    onTypeOrmExecutor();
    afterEach(async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE consolidation_key = :key`,
        { key: WIDE_KEY }
      );
    });

    it('queues the top-up under the key it would be written to', async () => {
      const source = db.getDataSource();
      const createRunner = source.createQueryRunner.bind(source);
      let moved = false;
      jest.spyOn(source, 'createQueryRunner').mockImplementation((mode) => {
        const runner = createRunner(mode);
        const query = runner.query.bind(runner) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        jest.spyOn(runner, 'query').mockImplementation((async (
          ...args: unknown[]
        ) => {
          const result = await query(...args);
          // Right after the top-up reads the wallet's own key, the identity
          // sync puts the wallet in a fourteen-wallet identity.
          if (!moved && looksUpKeyOf(args, WIDE_WALLETS[0])) {
            moved = true;
            for (const address of WIDE_WALLETS) {
              await sqlExecutor.execute(
                `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
                  VALUES (:address, :key)
                  ON DUPLICATE KEY UPDATE consolidation_key = :key`,
                { address, key: WIDE_KEY }
              );
            }
          }
          return result;
        }) as never);
        return runner;
      });

      await persistTopUps([
        {
          hash: TOP_UP,
          block: 1,
          transaction_date: new Date('2026-11-20T00:00:00Z'),
          from_wallet: WIDE_WALLETS[0],
          amount: 0.05
        }
      ]);

      // The key-width guard judges the wide key the top-up moved to, not
      // the wallet's own key it read, and queues the whole top-up. Judged on
      // the wallet's key, the top-up would be written at once under the wide
      // key, whose other writes the guard holds back.
      expect(moved).toBe(true);
      expect(await balances()).toEqual([]);
      expect(await queue()).toEqual([['TOP_UP', WIDE_KEY]]);
      expect(
        await sqlExecutor.execute(
          `SELECT hash FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
        )
      ).toEqual([]);
    });
  }
);

// A and B each subscribed to the card. The merge moves A's allocation to AB,
// leaves B's under B because AB already has the card, and moves both
// balances to AB.
describeWithSeed(
  'Real MySQL: a charge on an allocation a merge left under the old key',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [A, B].map((address) => ({ address, consolidation_key: AB }))
    },
    withTdhConsolidations([aTdhConsolidation([A, B], { boosted_tdh: 100 })]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: A, balance: 1 },
        { consolidation_key: B, balance: 1 }
      ]
    },
    {
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [
        finalAllocation(A),
        { ...finalAllocation(B), airdrop_address: B, phase_position: 2 }
      ]
    }
  ],
  () => {
    onTypeOrmExecutor();

    it('charges the key the merge moved the balance to', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      await db
        .getDataSource()
        .transaction((manager) => processAirdrop(airdropTo(B), manager));

      // Without following the move: a new row for B at minus the mint price,
      // and AB untouched at 2.
      const [[key, balance], ...rest] = await balances();
      expect(rest).toEqual([]);
      expect(key).toBe(AB);
      expect(balance).toBeCloseTo(2 - MEMES_MINT_PRICE, 10);
      expect(await redemptionKeys()).toEqual([AB]);
      expect(await sqlExecutor.execute(BALANCES_UNDER_A_MERGED_KEY)).toEqual(
        []
      );
    });

    it('holds the charge back when the key it moved to has earlier writes waiting', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      await queueEarlierWrite(AB);
      await db
        .getDataSource()
        .transaction((manager) => processAirdrop(airdropTo(B), manager));

      // The key-width guard judges AB, the key that would pay, not B, the
      // allocation's key. Judged on B the charge would be taken from AB now.
      expect(await balances()).toEqual([[AB, 2]]);
      expect(await redemptionKeys()).toEqual([]);
      expect(await queue()).toEqual([
        ['LOG', AB],
        ['REDEMPTION', AB]
      ]);
    });
  }
);

// Balances as the old code could leave them: A's row recreated by a late
// top-up after A and B were merged into AB. C is a key of its own.
describeWithSeed(
  'Real MySQL: the check for balances under a merged key',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        ...[A, B].map((address) => ({ address, consolidation_key: AB })),
        { address: '0xc', consolidation_key: '0xc' }
      ]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: A, balance: 0.05 },
        { consolidation_key: AB, balance: 5 },
        { consolidation_key: '0xc', balance: 1 }
      ]
    }
  ],
  () => {
    onTypeOrmExecutor();

    it('lists the balance left under A', async () => {
      const rows = await sqlExecutor.execute<{
        consolidation_key: string;
        balance: number;
        current_key: string;
      }>(BALANCES_UNDER_A_MERGED_KEY);
      expect(
        rows.map((row) => [
          row.consolidation_key,
          Number(row.balance),
          row.current_key
        ])
      ).toEqual([[A, 0.05, AB]]);
    });
  }
);
