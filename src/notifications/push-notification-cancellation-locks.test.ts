import { PushNotificationCancellationsDb } from './push-notification-cancellations.db';
import { SqlExecutor } from '@/sql-executor';

it('locks the combined drop references through the primary key before deleting', async () => {
  const execute = jest
    .fn()
    .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
    .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
    .mockResolvedValue([]);
  const db = new PushNotificationCancellationsDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  const connection = { connection: {} };
  await db.cancelAndDelete('drop', ['a'], { connection });
  expect(execute.mock.calls[0][0]).toContain(
    '(related_drop_id in (:values) or related_drop_2_id in (:values))'
  );
  expect(execute.mock.calls[0][0]).not.toContain('for update');
  expect(execute.mock.calls[1][0]).toContain('force index (PRIMARY)');
  expect(execute.mock.calls[1][0]).toContain('order by id for update');
  expect(execute.mock.calls[1][1]).toEqual({ ids: [1, 2], values: ['a'] });
  expect(execute.mock.calls[3][1]).toEqual({ ids: [1, 2] });
  for (const call of execute.mock.calls)
    expect(call[2]).toEqual({ wrappedConnection: connection });
});

it('advances past candidates already deleted by another transaction', async () => {
  const execute = jest
    .fn()
    .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  const db = new PushNotificationCancellationsDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  await db.cancelAndDelete('drop', ['a'], { connection: { connection: {} } });
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[2][1]).toEqual({ values: ['a'], afterId: 2 });
  expect(execute.mock.calls.some((call) => call[0].startsWith('delete'))).toBe(
    false
  );
});
