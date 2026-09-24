import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { PushNotificationOutboxDb } from './push-notification-outbox.db';

describeWithSeed('Push outbox transaction visibility', [], () => {
  const repo = new PushNotificationOutboxDb(() => sqlExecutor);
  it('never publishes uncommitted work and publishes after commit', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await repo.enqueue(123, { connection });
        expect(await repo.publishBatch(send)).toBe(0);
        expect(send).not.toHaveBeenCalled();
      },
      { isolationLevel: 'REPEATABLE READ' }
    );
    expect(await repo.publishBatch(send)).toBe(1);
    expect(send).toHaveBeenCalledWith([123]);
    expect(await repo.publishBatch(send)).toBe(0);
  });

  it('rolls back work and retains committed work after failed publication', async () => {
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.enqueue(124, { connection });
          throw new Error('rollback');
        },
        { isolationLevel: 'REPEATABLE READ' }
      )
    ).rejects.toThrow('rollback');
    const send = jest.fn().mockResolvedValue(undefined);
    expect(await repo.publishBatch(send)).toBe(0);
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      repo.enqueue(125, { connection })
    );
    await expect(
      repo.publishBatch(async () => {
        throw new Error('SQS unavailable');
      })
    ).rejects.toThrow('SQS unavailable');
    expect(await repo.publishBatch(send)).toBe(1);
    expect(send).toHaveBeenCalledWith([125]);
  });
});
