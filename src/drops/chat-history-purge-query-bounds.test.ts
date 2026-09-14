import { ChatHistoryPurgeDb } from './chat-history-purge.db';

it('keeps SQL statement count constant for one and one hundred deleted messages', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const repo = new ChatHistoryPurgeDb(() => ({ execute }) as never);
  const ctx = { connection: {} } as never;
  const scope = { waveId: 'wave', authorId: 'author', cutoffSerialNo: 60000 };
  await repo.deleteBatch(scope, ['drop-1'], ctx);
  const singleQueries = execute.mock.calls.length;
  execute.mockClear();
  await repo.deleteBatch(
    scope,
    Array.from({ length: 100 }, (_, i) => `drop-${i}`),
    ctx
  );
  expect(execute.mock.calls).toHaveLength(singleQueries);
  expect(singleQueries).toBeLessThan(40);
  execute.mockClear();
  await expect(
    repo.deleteBatch(
      scope,
      Array.from({ length: 101 }, (_, i) => `drop-${i}`),
      ctx
    )
  ).rejects.toThrow('bounded transaction');
  expect(execute).not.toHaveBeenCalled();
  await expect(
    repo.findBatchForUpdate({ ...scope, pinnedDropId: null }, {})
  ).rejects.toThrow('requires a transaction');
});
