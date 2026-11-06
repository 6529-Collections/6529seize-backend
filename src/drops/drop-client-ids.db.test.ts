import 'reflect-metadata';
import { DROP_CLIENT_IDS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
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
      const second = sqlExecutor
        .executeNativeQueriesInTransaction((connection) =>
          repo.insert(row(ID_A, 'drop-b'), { connection })
        )
        .finally(() => {
          secondSettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondSettled).toBe(false);
      releaseFirst.resolve();

      await first;
      await expect(second).rejects.toBeInstanceOf(DropClientIdTakenError);
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
      const second = sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => repo.insert(row(ID_A, 'drop-b'), { connection })
      );
      releaseFirst.resolve();

      await expect(first).rejects.toThrow('first attempt failed');
      await second;
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
