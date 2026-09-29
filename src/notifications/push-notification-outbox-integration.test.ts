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

  it('holds locks on one connection across send and deletes an entire multi-ID batch', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      for (const id of [201, 202, 203]) await repo.enqueue(id, { connection });
    });
    const firstSend = jest.fn(async (ids: number[]) => {
      expect(ids).toEqual([201, 202, 203]);
      const overlappingSend = jest.fn();
      expect(await repo.publishBatch(overlappingSend)).toBe(0);
      expect(overlappingSend).not.toHaveBeenCalled();
    });
    expect(await repo.publishBatch(firstSend)).toBe(3);
    expect(await repo.oldestPendingAt()).toBeNull();
    expect(await repo.publishBatch(jest.fn())).toBe(0);
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
