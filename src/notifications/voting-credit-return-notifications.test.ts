import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  IdentityNotificationDeserialized,
  IdentityNotificationsDb
} from './identity-notifications.db';
import { UserNotificationMapper } from './user-notification.mapper';
import { UserNotifier } from './user.notifier';
import type { VotingCreditsReturnedNotificationData } from './user-notification.types';
import type { ConnectionWrapper } from '@/sql-executor';
import type { SqlExecutor } from '@/sql-executor';
import { VotingCreditReturnsDb } from './voting-credit-returns.db';
import { PushNotificationOutboxDb } from './push-notification-outbox.db';
import { VotingCreditReturnNotificationsService } from './voting-credit-return-notifications.service';
import { recordVotingCreditReturnMetrics } from './voting-credit-return-metrics';

const data: VotingCreditsReturnedNotificationData = {
  event_id: 'release',
  reason: 'AUTHOR_DELETED',
  wave_id: 'wave',
  competition_id: 'competition',
  competition_title: 'Main Stage',
  entry_id: 'entry',
  drop_id: 'deleted',
  submission_title: 'Freedom To Transcend',
  credit_type: 'TDH',
  amount: 500,
  released_at: 1000
};

it('creates a private, batched credit-return notification without a live drop or actor dependency', async () => {
  const insertManyNotifications = jest.fn().mockResolvedValue([123]);
  const notifier = new UserNotifier({
    insertManyNotifications
  } as unknown as IdentityNotificationsDb);
  const connection = {} as ConnectionWrapper<unknown>;
  expect(
    await notifier.notifyOfVotingCreditReturns(
      [{ recipientId: 'voter', data }],
      'private-group',
      { connection }
    )
  ).toEqual([123]);
  const row = insertManyNotifications.mock.calls[0][0][0];
  expect(row).toMatchObject({
    identity_id: 'voter',
    cause: IdentityNotificationCause.VOTING_CREDITS_RETURNED,
    additional_identity_id: null,
    related_drop_id: null,
    related_drop_2_id: null,
    visibility_group_id: 'private-group',
    additional_data: data
  });
  expect(insertManyNotifications.mock.calls[0][1]).toBe(connection);
  expect(
    new UserNotificationMapper().mapNotifications([
      {
        ...row,
        id: 123,
        created_at: 2000,
        read_at: null
      } as IdentityNotificationDeserialized
    ])[0]
  ).toMatchObject({
    cause: IdentityNotificationCause.VOTING_CREDITS_RETURNED,
    data
  });
  await expect(
    notifier.notifyOfVotingCreditReturns(
      [{ recipientId: 'voter', data }],
      null,
      {}
    )
  ).rejects.toThrow('require a transaction');
});

it('treats an empty push batch as a no-op without acquiring a database connection', async () => {
  const outbox = new PushNotificationOutboxDb(() => {
    throw new Error('Unexpected DB call');
  });
  await expect(outbox.enqueueMany([], {})).resolves.toBeUndefined();
});

it('rejects an outer transaction before processing or retry writes', async () => {
  const repository = new VotingCreditReturnsDb(() => {
    throw new Error('Unexpected DB call');
  });
  await expect(
    repository.processBatch(jest.fn(), 1000, {
      connection: {} as ConnectionWrapper<unknown>
    })
  ).rejects.toThrow('owns its transaction');
});

it('preserves the delivery failure if the separate retry update also fails', async () => {
  const originalError = new Error('Delivery failed');
  const connection = {} as ConnectionWrapper<unknown>;
  const db = {
    execute: jest.fn(async (sql: string) => {
      if (sql.includes('set next_attempt_at'))
        throw new Error('Retry update failed');
      if (sql.includes('select voter_profile_id'))
        return [{ voter_profile_id: 'voter', amount: 500 }];
      return [{ id: 'release', context: data, after_profile_id: '' }];
    }),
    executeNativeQueriesInTransaction: async (
      action: (tx: ConnectionWrapper<unknown>) => Promise<unknown>
    ) => action(connection)
  } as unknown as SqlExecutor;
  const repository = new VotingCreditReturnsDb(() => db);
  await expect(
    repository.processBatch(async () => {
      throw originalError;
    }, 1000)
  ).rejects.toBe(originalError);
});

it('continues delivery when backlog observability fails', async () => {
  const previous = process.env.USER_NOTIFIER_ACTIVATED;
  process.env.USER_NOTIFIER_ACTIVATED = 'true';
  const repository = {
    deliveryStats: jest.fn().mockRejectedValue(new Error('Stats failed')),
    processBatch: jest.fn().mockResolvedValue(false)
  };
  try {
    await expect(
      new VotingCreditReturnNotificationsService(repository).processPending()
    ).resolves.toBeUndefined();
    expect(repository.processBatch).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.USER_NOTIFIER_ACTIVATED;
    else process.env.USER_NOTIFIER_ACTIVATED = previous;
  }
});

it('publishes pending and dead-letter counts as valid CloudWatch EMF without network calls', () => {
  const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    recordVotingCreditReturnMetrics({
      oldest_pending_at: 1000,
      pending_releases: 21,
      failed_releases: 1
    });
    const event = JSON.parse(String(write.mock.calls[0][0]));
    expect(event).toMatchObject({
      PendingReleases: 21,
      DeadLetterReleases: 1,
      _aws: {
        CloudWatchMetrics: [
          { Namespace: 'VotingCreditReturns', Dimensions: [[]] }
        ]
      }
    });
  } finally {
    write.mockRestore();
  }
});
