import { HelpBotDailyActivityCreditRequestStatus } from '@/entities/IHelpBotDailyActivityCreditRequest';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import {
  HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME,
  HELP_BOT_DAILY_ACTIVITY_CREDITS_MESSAGE_GROUP_ID,
  HelpBotDailyActivityCreditQueueService
} from './help-bot-daily-activity-credit-queue.service';

function createService() {
  const connection = { connection: {} };
  const executor = {
    execute: jest.fn(),
    getAffectedRows: jest.fn((result: { affectedRows?: number }) =>
      Number(result.affectedRows ?? 0)
    )
  };
  const creditsService = {
    grantDailyActivityCredits: jest.fn()
  };
  const sqsClient = {
    sendToQueueName: jest.fn()
  };
  const service = new HelpBotDailyActivityCreditQueueService(
    () => executor as never,
    creditsService as never,
    sqsClient as never
  );
  return { connection, creditsService, executor, service, sqsClient };
}

describe('HelpBotDailyActivityCreditQueueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('durably enqueues one request per profile and UTC day in the caller transaction', async () => {
    const { connection, executor, service } = createService();
    executor.execute.mockResolvedValue({ affectedRows: 1 });

    await expect(
      service.enqueueRequest(
        {
          profileId: 'profile-1',
          requestedAt: Date.UTC(2026, 7, 29, 23, 59, 59)
        },
        { connection } as RequestContext
      )
    ).resolves.toBe(true);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT IGNORE INTO help_bot_daily_activity_credit_requests'
      ),
      {
        profileId: 'profile-1',
        activityDate: '2026-08-29',
        status: HelpBotDailyActivityCreditRequestStatus.PENDING,
        requestedAt: Date.UTC(2026, 7, 29, 23, 59, 59)
      },
      { wrappedConnection: connection }
    );
  });

  it('reports a duplicate daily request without replacing completed state', async () => {
    const { executor, service } = createService();
    executor.execute.mockResolvedValue({ affectedRows: 0 });

    await expect(
      service.enqueueRequest({
        profileId: 'profile-1',
        requestedAt: Date.UTC(2026, 7, 29)
      })
    ).resolves.toBe(false);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute.mock.calls[0][0]).toContain('INSERT IGNORE');
  });

  it('publishes a small wakeup without putting credit work in the API path', async () => {
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

  it('keeps the committed request available when SQS publication fails', async () => {
    const { service, sqsClient } = createService();
    sqsClient.sendToQueueName.mockRejectedValue(new Error('sqs unavailable'));

    await expect(service.sendWakeupBestEffort({})).resolves.toBeUndefined();
  });

  it('processes a queued day and records completion', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([
        {
          profile_id: 'profile-1',
          activity_date: '2026-08-29',
          attempts: 0
        }
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);
    creditsService.grantDailyActivityCredits.mockResolvedValue({
      amountGranted: 1,
      balance: 3,
      alreadyGranted: false,
      botProfileMissing: false
    });

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: true,
      failed: false,
      dead: false,
      hasMore: false
    });

    expect(creditsService.grantDailyActivityCredits).toHaveBeenCalledWith(
      {
        profileId: 'profile-1',
        nowMillis: Date.UTC(2026, 7, 29)
      },
      {}
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
    expect(executor.execute.mock.calls[0][0]).toContain(
      'ORDER BY attempts ASC'
    );
  });

  it('treats an already-granted credit event as successful duplicate delivery', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([
        {
          profile_id: 'profile-1',
          activity_date: '2026-08-29',
          attempts: 1
        }
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);
    creditsService.grantDailyActivityCredits.mockResolvedValue({
      amountGranted: 0,
      balance: 3,
      alreadyGranted: true,
      botProfileMissing: false
    });

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: true,
      failed: false,
      dead: false,
      hasMore: false
    });
    expect(executor.execute.mock.calls[1][0]).toContain(
      'SET status = :completedStatus'
    );
  });

  it('does no credit work for a duplicate wakeup after completion', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute.mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: false,
      dead: false,
      hasMore: false
    });
    expect(creditsService.grantDailyActivityCredits).not.toHaveBeenCalled();
  });

  it('records retry state when identities-table work fails', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([
        {
          profile_id: 'profile-1',
          activity_date: '2026-08-29',
          attempts: 7
        }
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([{ profile_id: 'profile-2' }]);
    creditsService.grantDailyActivityCredits.mockRejectedValue(
      new Error('Lock wait timeout exceeded')
    );

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: true,
      dead: false,
      hasMore: true
    });
    expect(executor.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('attempts = attempts + 1'),
      expect.objectContaining({
        nextStatus: HelpBotDailyActivityCreditRequestStatus.PENDING,
        lastError: 'Lock wait timeout exceeded'
      }),
      expect.objectContaining({ forcePool: DbPoolName.WRITE })
    );
  });

  it('parks and exposes a request after the terminal retry attempt', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([
        {
          profile_id: 'profile-1',
          activity_date: '2026-08-29',
          attempts: 99
        }
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);
    creditsService.grantDailyActivityCredits.mockRejectedValue(
      new Error('persistent failure')
    );

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: true,
      dead: true,
      hasMore: false
    });
    expect(executor.execute.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        nextStatus: HelpBotDailyActivityCreditRequestStatus.DEAD
      })
    );
  });

  it('parks a malformed persisted activity date on its first attempt', async () => {
    const { creditsService, executor, service } = createService();
    executor.execute
      .mockResolvedValueOnce([
        {
          profile_id: 'profile-1',
          activity_date: 'not-a-date',
          attempts: 0
        }
      ])
      .mockResolvedValueOnce({ affectedRows: 1 })
      .mockResolvedValueOnce([]);

    await expect(service.processNextRequest({})).resolves.toEqual({
      processed: false,
      failed: true,
      dead: true,
      hasMore: false
    });
    expect(creditsService.grantDailyActivityCredits).not.toHaveBeenCalled();
    expect(executor.execute.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        nextStatus: HelpBotDailyActivityCreditRequestStatus.DEAD,
        lastError: 'Invalid help bot activity date: not-a-date'
      })
    );
  });
});
