import { PushNotificationOutboxDb } from './push-notification-outbox.db';
import { SqlExecutor } from '@/sql-executor';

function fixture(ids: number[] = [1, 2]) {
  const connection = { connection: null };
  const execute = jest
    .fn()
    .mockResolvedValue(ids.map((notification_id) => ({ notification_id })));
  const transaction = jest.fn(async (callback) => callback(connection));
  const db = {
    execute,
    executeNativeQueriesInTransaction: transaction
  } as unknown as SqlExecutor;
  return {
    repo: new PushNotificationOutboxDb(() => db),
    execute,
    transaction,
    connection
  };
}

it('stores notification work on the same transaction and rejects autocommit', async () => {
  const { repo, execute, connection } = fixture();
  await expect(repo.enqueue(42, {})).rejects.toThrow('requires a transaction');
  expect(execute).not.toHaveBeenCalled();
  await repo.enqueue(42, { connection });
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('insert into'),
    expect.objectContaining({ notificationId: 42 }),
    { wrappedConnection: connection }
  );
});

it('deletes committed work only after successful publication on its locked transaction', async () => {
  const { repo, execute, connection } = fixture();
  const send = jest.fn(async () => {
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('for update skip locked');
  });
  expect(await repo.publishBatch(send)).toBe(2);
  expect(send).toHaveBeenCalledWith([1, 2]);
  expect(execute).toHaveBeenLastCalledWith(
    expect.stringContaining('delete from'),
    { ids: [1, 2] },
    { wrappedConnection: connection }
  );
});

it('keeps rows for retry when SQS fails, including partial batch failure', async () => {
  const { repo, execute } = fixture();
  await expect(
    repo.publishBatch(async () => {
      throw new Error('partial failure');
    })
  ).rejects.toThrow('partial failure');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('does not send an empty batch', async () => {
  const { repo } = fixture([]);
  const send = jest.fn();
  expect(await repo.publishBatch(send)).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
