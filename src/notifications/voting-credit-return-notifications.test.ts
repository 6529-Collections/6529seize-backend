import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  IdentityNotificationDeserialized,
  IdentityNotificationsDb
} from './identity-notifications.db';
import { UserNotificationMapper } from './user-notification.mapper';
import { UserNotifier } from './user.notifier';
import type { VotingCreditsReturnedNotificationData } from './user-notification.types';
import type { ConnectionWrapper } from '@/sql-executor';

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
