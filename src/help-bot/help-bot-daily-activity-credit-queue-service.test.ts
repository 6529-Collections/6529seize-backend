import { HelpBotDailyActivityCreditRequestStatus } from '@/entities/IHelpBotDailyActivityCreditRequest';
import { DbPoolName } from '@/db-query.options';
import {
  HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME,
  HELP_BOT_DAILY_ACTIVITY_CREDITS_MESSAGE_GROUP_ID,
  HelpBotDailyActivityCreditQueueService
} from './help-bot-daily-activity-credit-queue.service';

function createService() {
  const executor = {
    execute: jest.fn(),
    getAffectedRows: jest.fn((result: { affectedRows?: number }) =>
      Number(result.affectedRows ?? 0)
    )
  };
  const sqsClient = {
    sendToQueueName: jest.fn()
  };
  const service = new HelpBotDailyActivityCreditQueueService(
    () => executor as never,
    sqsClient as never
  );
  return { executor, service, sqsClient };
}

function pendingRow(attempts = 0) {
  return {
    profile_id: 'profile-1',
    activity_date: '2026-08-29',
    attempts
  };
}

describe('HelpBotDailyActivityCreditQueueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes a continuation wakeup to the FIFO queue', async () => {
    const { service, sqsClient } = createService();
    sqsClient.sendToQueueName.mockResolvedValue(undefined);

    await service.sendWakeup({});

    expect(sqsClient.sendToQueueName).toHaveBeenCalledWith({
      queueName: HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME,
      messageGroupId: HELP_BOT_DAILY_ACTIVITY_CREDITS_MESSAGE_GROUP_ID,
      message: {
        requestedAt: expect.any(Number),
        nonce: expect.any(String)
      }
    });
  });

  it('completes a leftover request without granting anything', async () => {
    const { executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([pendingRow()])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: true,
      failed: false,
      dead: false,
      hasMore: false
    });

    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(executor.execute.mock.calls[0][0]).toContain(
      'ORDER BY attempts ASC'
    );
    expect(executor.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SET status = :completedStatus'),
      expect.objectContaining({
        completedStatus: HelpBotDailyActivityCreditRequestStatus.COMPLETED,
        profileId: 'profile-1',
        activityDate: '2026-08-29'
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
    for (const [sql] of executor.execute.mock.calls) {
      expect(sql).not.toMatch(/ratings|identities|help_bot_credit_events/i);
    }
  });

  it('completes a request whatever its stored activity date', async () => {
    const { executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([{ ...pendingRow(), activity_date: 'not-a-date' }])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual(
      expect.objectContaining({ processed: true, failed: false })
    );
  });

  it('reports more work while other requests are pending', async () => {
    const { executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([pendingRow()])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ profile_id: 'profile-2' }]);

    await expect(service.processNextRequest({})).resolves.toEqual(
      expect.objectContaining({ processed: true, hasMore: true })
    );
  });

  it('does nothing for a wakeup with no pending request', async () => {
    const { executor, service } = createService();
    executor.execute.mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: false,
      dead: false,
      hasMore: false
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('records retry state when completing a request fails', async () => {
    const { executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([pendingRow(7)])
      .mockRejectedValueOnce(new Error('Lock wait timeout exceeded'))
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ profile_id: 'profile-2' }]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: true,
      dead: false,
      hasMore: true
    });
    expect(executor.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('attempts = attempts + 1'),
      expect.objectContaining({
        nextStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        lastError: 'Lock wait timeout exceeded'
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('parks a request after the terminal retry attempt', async () => {
    const { executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([pendingRow(99)])
      .mockRejectedValueOnce(new Error('persistent failure'))
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: true,
      dead: true,
      hasMore: false
    });
    expect(executor.execute.mock.calls[2][1]).toEqual(
      expect.objectContaining({
        nextStatus: HelpBotDailyActivityCreditRequestStatus.DEAD
      })
    );
  });

  it('deletes completed requests after their retention', async () => {
    const { executor, service } = createService();
    executor.execute.mockResolvedValueOnce({ affectedRows: 0 });

    await service.cleanupCompletedRequests({});

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'DELETE FROM help_bot_daily_activity_credit_requests'
      ),
      expect.objectContaining({
        completedStatus: HelpBotDailyActivityCreditRequestStatus.COMPLETED
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });
});
