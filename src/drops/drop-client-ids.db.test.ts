import 'reflect-metadata';
import { DROP_CLIENT_IDS_TABLE } from '@/constants';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DropClientIdsDb, DropClientIdTakenError } from './drop-client-ids.db';

const repo = new DropClientIdsDb(() => sqlExecutor);

function row(clientDropId: string, dropId: string, authorId = 'author-1') {
  return {
    author_id: authorId,
    client_drop_id: clientDropId,
    drop_id: dropId,
    wave_id: 'wave-1',
    content_fingerprint: 'fp-1',
    created_at: 1_000
  };
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

/** Captures a promise's outcome at once, so an early rejection is never unhandled. */
function settle<T>(
  promise: Promise<T>
): Promise<
  { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
}

/** The server's id for a transaction's own connection. */
async function connectionIdOf(
  connection: ConnectionWrapper<unknown>
): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ id: number | string }>(
    'select connection_id() as id',
    undefined,
    { wrappedConnection: connection }
  );
  return Number(row?.id);
}

/**
 * Barrier on the database's own state: resolves once the transaction on
 * connection `threadId` (the duplicate claim) is blocked waiting for a row
 * lock, i.e. parked on the first claim's key. It follows that one connection
 * by id instead of scanning every transaction through the process list, and
 * reports what that connection was doing if it never waits.
 */
async function untilWaitingForALock(threadId: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const trx = await sqlExecutor.oneOrNull<{ trx_state: string }>(
      `select trx_state from information_schema.innodb_trx
       where trx_mysql_thread_id = :threadId`,
      { threadId }
    );
    if (trx?.trx_state === 'LOCK WAIT') return;
    if (Date.now() > deadline) {
      const thread = await sqlExecutor.oneOrNull(
        `select command, state, time, info from information_schema.processlist
         where id = :threadId`,
        { threadId }
      );
      throw new Error(
        `The duplicate claim never waited for the first claim: transaction ${JSON.stringify(
          trx
        )}, connection ${JSON.stringify(thread)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Starts the duplicate claim of `clientDropId` in its own transaction and
 * resolves with its connection id once the claim is about to insert.
 */
function startDuplicateClaim(clientDropId: string, dropId: string) {
  let threadId!: (id: number) => void;
  const started = new Promise<number>((resolve) => (threadId = resolve));
  const claim = sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      threadId(await connectionIdOf(connection));
      return repo.insert(row(clientDropId, dropId), { connection });
    }
  );
  return { started, claim };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describeWithSeed(
  'DropClientIdsDb',
  { table: DROP_CLIENT_IDS_TABLE, rows: [] },
  () => {
    it('finds a claimed id and nothing for an unknown one', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.insert(row(ID_A, 'drop-a'), { connection })
      );

      await expect(
        repo.find({ authorId: 'author-1', clientDropId: ID_A }, {})
      ).resolves.toEqual(row(ID_A, 'drop-a'));
      await expect(
        repo.find({ authorId: 'author-1', clientDropId: ID_B }, {})
      ).resolves.toBeNull();
      await expect(
        repo.find({ authorId: 'author-2', clientDropId: ID_A }, {})
      ).resolves.toBeNull();
    });

    it('lets different authors use the same id', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.insert(row(ID_A, 'drop-a'), { connection });
          await repo.insert(row(ID_A, 'drop-z', 'author-2'), { connection });
        }
      );

      await expect(
        repo.find({ authorId: 'author-2', clientDropId: ID_A }, {})
      ).resolves.toMatchObject({ drop_id: 'drop-z' });
    });

    it('refuses a second claim of the same id by the same author', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.insert(row(ID_A, 'drop-a'), { connection })
      );

      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          repo.insert(row(ID_A, 'drop-b'), { connection })
        )
      ).rejects.toBeInstanceOf(DropClientIdTakenError);
      await expect(
        repo.find({ authorId: 'author-1', clientDropId: ID_A }, {})
      ).resolves.toMatchObject({ drop_id: 'drop-a' });
    });

    it('requires a transaction to claim', async () => {
      await expect(repo.insert(row(ID_A, 'drop-a'), {})).rejects.toThrow(
        'requires a transaction'
      );
    });

    it('makes a concurrent duplicate wait for the first claim and then fail', async () => {
      const firstClaimed = deferred();
      const releaseFirst = deferred();
      const first = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.insert(row(ID_A, 'drop-a'), { connection });
          firstClaimed.resolve();
          await releaseFirst.promise;
        }
      );
      await firstClaimed.promise;
      let secondSettled = false;
      const duplicate = startDuplicateClaim(ID_A, 'drop-b');
      const second = settle(
        duplicate.claim.finally(() => {
          secondSettled = true;
        })
      );

      const firstOutcome = settle(first);
      try {
        // The duplicate is parked on the first claim's key, not finished.
        await untilWaitingForALock(await duplicate.started);
        expect(secondSettled).toBe(false);
      } finally {
        // Never leave the first transaction open: it would block the reset.
        releaseFirst.resolve();
      }

      expect(await firstOutcome).toMatchObject({ status: 'fulfilled' });
      const outcome = await second;
      expect(outcome.status).toBe('rejected');
      expect(
        outcome.status === 'rejected' ? outcome.reason : undefined
      ).toBeInstanceOf(DropClientIdTakenError);
    });

    it('lets the duplicate through when the first attempt rolls back', async () => {
      const firstClaimed = deferred();
      const releaseFirst = deferred();
      const first = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.insert(row(ID_A, 'drop-a'), { connection });
          firstClaimed.resolve();
          await releaseFirst.promise;
          throw new Error('first attempt failed');
        }
      );
      await firstClaimed.promise;
      const firstOutcome = settle(first);
      const duplicate = startDuplicateClaim(ID_A, 'drop-b');
      const second = settle(duplicate.claim);
      try {
        // The duplicate must block on the first claim before it can succeed.
        await untilWaitingForALock(await duplicate.started);
      } finally {
        releaseFirst.resolve();
      }

      expect(await firstOutcome).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'first attempt failed' })
      });
      expect(await second).toMatchObject({ status: 'fulfilled' });
      await expect(
        repo.find({ authorId: 'author-1', clientDropId: ID_A }, {})
      ).resolves.toMatchObject({ drop_id: 'drop-b' });
    });

    it('does not block a different id from the same author', async () => {
      const firstClaimed = deferred();
      const releaseFirst = deferred();
      const first = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.insert(row(ID_A, 'drop-a'), { connection });
          firstClaimed.resolve();
          await releaseFirst.promise;
        }
      );
      await firstClaimed.promise;

      // Completes while the first claim's transaction is still open.
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.insert(row(ID_B, 'drop-b'), { connection })
      );
      releaseFirst.resolve();
      await first;

      await expect(
        repo.find({ authorId: 'author-1', clientDropId: ID_B }, {})
      ).resolves.toMatchObject({ drop_id: 'drop-b' });
    });
  }
);
