import { performance } from 'node:perf_hooks';
import * as loopDb from '@/db';
import { beforeCommit } from '@/db/after-commit';
import {
  primaryQueryOptions,
  withPrimaryTransaction
} from '@/db/primary-transaction';
import {
  assertIdentityNotFrozenAtCommit,
  IDENTITY_FROZEN_MESSAGE,
  IdentityFrozenException
} from '@/identity-freeze/identity-freeze';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutionBudget,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import { freezeClock, settle } from '@/tests/fixtures/freeze-at-commit.fixture';
import {
  createSqlTransactionFixture,
  SQL_TRANSACTION_FIXTURE_TABLE,
  SqlTransactionFixtureEntity
} from './sql-transaction-fixture';

const id = 'before-commit';
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

type Write = (
  db: SqlExecutor,
  work: (connection: ConnectionWrapper<any>) => Promise<void>
) => Promise<void>;

/** A plain transaction and a budgeted one, each writing the fixture row. */
const transactions: [string, Write][] = [
  [
    'a plain transaction',
    (db, work) =>
      db.executeNativeQueriesInTransaction(async (connection) => {
        await db.execute(update, { id }, { wrappedConnection: connection });
        await work(connection);
      })
  ],
  [
    'a budgeted transaction',
    (db, work) =>
      withPrimaryTransaction(
        db,
        async (ctx) => {
          await db.execute(update, { id }, primaryQueryOptions(ctx));
          await work(ctx.connection);
        },
        {},
        budget()
      )
  ]
];

/** The same cases against whichever executor `db()` returns. */
function checksBeforeCommit(
  db: () => SqlExecutor,
  observer: () => SqlExecutor
) {
  async function committedVersion(): Promise<string> {
    const rows = await observer().execute<{ version: string }>(read, { id });
    return rows[0].version;
  }

  describe.each(transactions)('%s', (_, write) => {
    it('commits the write when the check passes', async () => {
      const check = jest.fn();
      await write(db(), async (connection) => {
        beforeCommit(connection, 'k', check);
        expect(check).not.toHaveBeenCalled();
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(await committedVersion()).toBe('2');
    });

    it('rolls the write back and rethrows the freeze error when the check fails', async () => {
      const failure = new IdentityFrozenException();
      const { error } = await settle(
        write(db(), async (connection) => {
          beforeCommit(connection, 'k', () => {
            throw failure;
          });
        })
      );
      expect(error).toBe(failure);
      expect(await committedVersion()).toBe('1');

      // The next transaction is not refused by what the failed one left.
      await write(db(), async () => undefined);
      expect(await committedVersion()).toBe('2');
    });

    it('rolls back an identity write admitted before the freeze time that reaches COMMIT after it', async () => {
      const clock = freezeClock();
      try {
        const { error } = await settle(
          write(db(), async (connection) => {
            assertIdentityNotFrozenAtCommit(connection);
            clock.pass();
          })
        );
        expect(error).toBeInstanceOf(IdentityFrozenException);
        expect((error as IdentityFrozenException).getStatusCode()).toBe(423);
        expect((error as Error).message).toBe(IDENTITY_FROZEN_MESSAGE);
      } finally {
        clock.restore();
      }
      expect(await committedVersion()).toBe('1');
    });
  });
}

describe('api transactions (my-sql.helpers) check before COMMIT', () => {
  beforeEach(async () => {
    await createSqlTransactionFixture();
    await sqlExecutor.execute(
      `INSERT INTO ${SQL_TRANSACTION_FIXTURE_TABLE} (id,version) VALUES (:id,1)`,
      { id }
    );
  });

  afterEach(async () => {
    await sqlExecutor.execute(
      `DROP TABLE IF EXISTS ${SQL_TRANSACTION_FIXTURE_TABLE}`
    );
  });

  checksBeforeCommit(
    () => sqlExecutor,
    () => sqlExecutor
  );
});

describe('loop transactions (db.ts) check before COMMIT', () => {
  let observer: SqlExecutor;
  let db: SqlExecutor;

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

  checksBeforeCommit(
    () => db,
    () => observer
  );
});
