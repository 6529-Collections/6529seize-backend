import { performance } from 'node:perf_hooks';
import * as loopDb from '@/db';
import { afterCommit } from '@/db/after-commit';
import {
  primaryQueryOptions,
  withPrimaryTransaction
} from '@/db/primary-transaction';
import {
  setSqlExecutor,
  SqlExecutionBudget,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import {
  createSqlTransactionFixture,
  SQL_TRANSACTION_FIXTURE_TABLE,
  SqlTransactionFixtureEntity
} from './sql-transaction-fixture';

const id = 'loop-after-commit';
const read = `SELECT CAST(version AS CHAR) AS version FROM ${SQL_TRANSACTION_FIXTURE_TABLE} WHERE id=:id`;
const update = `UPDATE ${SQL_TRANSACTION_FIXTURE_TABLE} SET version=version+1 WHERE id=:id`;

function budget(): SqlExecutionBudget {
  return {
    deadlineMonotonicMillis: performance.now() + 5000,
    maxStatementMillis: 1000,
    finalizationReserveMillis: 1000,
    lockWaitSeconds: 1
  };
}

describe('loop (db.ts) transactions run afterCommit callbacks after COMMIT', () => {
  let observer: SqlExecutor;
  let db: SqlExecutor;

  async function committedVersion(): Promise<string> {
    const rows = await observer.execute<{ version: string }>(read, { id });
    return rows[0].version;
  }

  beforeEach(async () => {
    observer = sqlExecutor;
    await createSqlTransactionFixture();
    await observer.execute(
      `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id,version) VALUES (:id,1)`,
      { id }
    );
    await loopDb.connect([SqlTransactionFixtureEntity]);
    db = sqlExecutor;
  });

  afterEach(async () => {
    try {
      await loopDb.disconnect();
    } finally {
      setSqlExecutor(observer);
      await observer.execute(
        `DROP TABLE IF EXISTS ${SQL_TRANSACTION_FIXTURE_TABLE}`
      );
    }
  });

  it('defers a callback until the write is committed and visible to other connections', async () => {
    const events: string[] = [];
    let seenByCallback: string | undefined;
    await db.executeNativeQueriesInTransaction(async (connection) => {
      await db.execute(update, { id }, { wrappedConnection: connection });
      await afterCommit(connection, async () => {
        events.push('callback');
        seenByCallback = await committedVersion();
      });
      events.push('transaction body done');
    });
    events.push('returned');

    expect(events).toEqual(['transaction body done', 'callback', 'returned']);
    expect(seenByCallback).toBe('2');
  });

  it('never runs a callback when the transaction rolls back', async () => {
    const callback = jest.fn();
    await expect(
      db.executeNativeQueriesInTransaction(async (connection) => {
        await db.execute(update, { id }, { wrappedConnection: connection });
        await afterCommit(connection, callback);
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');

    expect(callback).not.toHaveBeenCalled();
    expect(await committedVersion()).toBe('1');
  });

  it('runs callbacks sharing a key once per commit', async () => {
    const callback = jest.fn();
    await db.executeNativeQueriesInTransaction(async (connection) => {
      await afterCommit(connection, callback, 'same-key');
      await afterCommit(connection, callback, 'same-key');
      expect(callback).not.toHaveBeenCalled();
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('defers callbacks in a budgeted transaction until its COMMIT is acknowledged', async () => {
    const events: string[] = [];
    let seenByCallback: string | undefined;
    await withPrimaryTransaction(
      db,
      async (ctx) => {
        await db.execute(update, { id }, primaryQueryOptions(ctx));
        await afterCommit(ctx.connection, async () => {
          events.push('callback');
          seenByCallback = await committedVersion();
        });
        events.push('transaction body done');
      },
      {},
      budget()
    );

    expect(events).toEqual(['transaction body done', 'callback']);
    expect(seenByCallback).toBe('2');
  });

  it('never runs a callback when a budgeted transaction rolls back', async () => {
    const callback = jest.fn();
    await expect(
      withPrimaryTransaction(
        db,
        async (ctx) => {
          await db.execute(update, { id }, primaryQueryOptions(ctx));
          await afterCommit(ctx.connection, callback);
          throw new Error('roll back');
        },
        {},
        budget()
      )
    ).rejects.toThrow('roll back');

    expect(callback).not.toHaveBeenCalled();
    expect(await committedVersion()).toBe('1');
  });
});
