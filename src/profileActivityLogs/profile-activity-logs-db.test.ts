import {
  PROFILE_LATEST_LOG_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { SqlExecutor } from '@/sql-executor';
import { ProfileActivityLogsDb } from './profile-activity-logs.db';

describe('ProfileActivityLogsDb', () => {
  let executor: jest.Mocked<SqlExecutor>;
  let db: ProfileActivityLogsDb;
  const connection = { connection: {} } as any;
  const log = {
    profile_id: 'profile-1',
    target_id: 'drop-1',
    contents: JSON.stringify({ reaction: ':+1:' }),
    type: ProfileActivityLogType.DROP_REACTED,
    proxy_id: null,
    additional_data_1: 'author-1',
    additional_data_2: 'wave-1'
  };

  beforeEach(() => {
    executor = {
      execute: jest.fn().mockResolvedValue([]),
      executeNativeQueriesInTransaction: jest.fn()
    } as unknown as jest.Mocked<SqlExecutor>;
    db = new ProfileActivityLogsDb(() => executor, {} as any);
  });

  it('inserts an activity log entry without touching latest activity', async () => {
    const createdAt = await db.insertLogEntry(log, connection);

    expect(createdAt).toBeInstanceOf(Date);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(PROFILES_ACTIVITY_LOGS_TABLE),
      expect.objectContaining({
        ...log,
        currentTime: createdAt,
        id: expect.any(String)
      }),
      { wrappedConnection: connection }
    );
    expect(executor.execute.mock.calls[0][0]).not.toContain(
      PROFILE_LATEST_LOG_TABLE
    );
  });

  it('retries retryable latest activity failures outside transactions', async () => {
    const latestActivity = new Date('2026-06-29T00:00:00.000Z');
    executor.execute
      .mockRejectedValueOnce({ code: 'ER_LOCK_DEADLOCK' })
      .mockResolvedValueOnce([]);

    await db.touchLatestActivity('profile-1', latestActivity);

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute).toHaveBeenLastCalledWith(
      expect.stringContaining(PROFILE_LATEST_LOG_TABLE),
      { profileId: 'profile-1', latestActivity },
      undefined
    );
  });

  it('does not retry latest activity failures inside an existing transaction', async () => {
    const latestActivity = new Date('2026-06-29T00:00:00.000Z');
    const error = { code: 'ER_LOCK_DEADLOCK' };
    executor.execute.mockRejectedValueOnce(error);

    await expect(
      db.touchLatestActivity('profile-1', latestActivity, connection)
    ).rejects.toBe(error);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(PROFILE_LATEST_LOG_TABLE),
      { profileId: 'profile-1', latestActivity },
      { wrappedConnection: connection }
    );
  });
});
