import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE
} from '@/constants';
import { connect, disconnect, execSQLWithParams, getDataSource } from '@/db';
import { DbQueryOptions } from '@/db-query.options';
import * as Entities from '@/entities/entities';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import {
  claimDeferredWrite,
  deferSubscriptionWrites,
  executorSink
} from '@/subscription-key-width/subscription-deferred-writes';
import { describeWithSeed } from '@/tests/_setup/seed';
import { persistTopUps, recordTopUps } from './db.subscriptions_topup';

jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

/**
 * persistTopUps works on a TypeORM QueryRunner, as in production; this runs
 * the production executor's statements on the test's data source.
 */
class TypeOrmExecutor extends SqlExecutor {
  execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    return execSQLWithParams(sql, params, options);
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    const runner = getDataSource().createQueryRunner();
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

const CREDITED = '0x00000000000000000000000000000000000000c1';
const RECORDED = '0x00000000000000000000000000000000000000c2';
const WAITING = '0x00000000000000000000000000000000000000c3';

function topUp(hash: string, wallet: string) {
  return {
    hash,
    block: 10,
    transaction_date: new Date('2026-01-01T00:00:00Z'),
    from_wallet: wallet,
    // Covers a card: a first top-up this size turns automatic mode on.
    amount: 0.25
  };
}

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('the top-up writes discovery can use', [], () => {
  beforeEach(async () => {
    setSqlExecutor(new TypeOrmExecutor());
    for (const wallet of [CREDITED, RECORDED, WAITING]) {
      await sqlExecutor.execute(
        `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:wallet, :wallet)`,
        { wallet }
      );
    }
  });

  it("the loop's own write credits, logs and turns automatic on; the record-only write adds the row alone", async () => {
    await persistTopUps([topUp(`0x${'c'.repeat(63)}1`, CREDITED)]);
    await recordTopUps([topUp(`0x${'c'.repeat(63)}2`, RECORDED)]);
    // Recording a hash again changes nothing.
    await recordTopUps([topUp(`0x${'c'.repeat(63)}2`, RECORDED)]);

    const rows = (table: string, column: string, wallet: string) =>
      sqlExecutor.execute<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE ${column} = :wallet`,
        { wallet }
      );
    for (const wallet of [CREDITED, RECORDED]) {
      expect(
        await rows(SUBSCRIPTIONS_TOP_UP_TABLE, 'from_wallet', wallet)
      ).toEqual([expect.objectContaining({ block: 10, amount: 0.25 })]);
    }
    expect(
      await rows(SUBSCRIPTIONS_BALANCES_TABLE, 'consolidation_key', CREDITED)
    ).toEqual([expect.objectContaining({ balance: 0.25 })]);
    expect(
      (await rows(SUBSCRIPTIONS_LOGS_TABLE, 'consolidation_key', CREDITED))
        .length
    ).toBeGreaterThan(0);
    expect(
      await rows(SUBSCRIPTIONS_MODE_TABLE, 'consolidation_key', CREDITED)
    ).toEqual([expect.objectContaining({ automatic: 1 })]);
    for (const table of [
      SUBSCRIPTIONS_BALANCES_TABLE,
      SUBSCRIPTIONS_LOGS_TABLE,
      SUBSCRIPTIONS_MODE_TABLE
    ]) {
      expect(await rows(table, 'consolidation_key', RECORDED)).toEqual([]);
    }
  });

  it("leaves out a top-up the loop's write queued, as the loop's write does, until the queue replays it", async () => {
    // An earlier write for the key waits, so the loop's write queues the
    // top-up whole: no row.
    await deferSubscriptionWrites(
      [
        {
          kind: 'LOG',
          consolidationKey: WAITING,
          dedupe: 'earlier',
          payload: {},
          reason: { narrow: [], pendingEarlier: false }
        }
      ],
      executorSink()
    );
    const queued = topUp(`0x${'c'.repeat(63)}3`, WAITING);
    await persistTopUps([queued]);
    const rows = () =>
      sqlExecutor.execute(
        `SELECT hash FROM ${SUBSCRIPTIONS_TOP_UP_TABLE} WHERE from_wallet = :wallet`,
        { wallet: WAITING }
      );
    expect(await rows()).toEqual([]);

    await recordTopUps([queued]);
    expect(await rows()).toEqual([]);

    // Once the queue's replay has claimed the key's writes as done, in
    // order, the record writes the row.
    const waiting = await sqlExecutor.execute<{ sequence: number }>(
      `SELECT sequence FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE} ORDER BY sequence`
    );
    expect(waiting).toHaveLength(2);
    for (const { sequence } of waiting) {
      expect(
        await claimDeferredWrite(Number(sequence), 'DONE', executorSink())
      ).toBe(true);
    }
    await recordTopUps([queued]);
    expect(await rows()).toEqual([{ hash: queued.hash }]);
  });
});
