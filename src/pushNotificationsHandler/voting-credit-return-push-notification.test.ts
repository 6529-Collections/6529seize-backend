import { buildVotingCreditReturnPushNotification } from './voting-credit-return-push-notification';
import { isNotificationEnabledForDevice } from './identity-push-notification-settings';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import type { VotingCreditsReturnedNotificationData } from '@/notifications/user-notification.types';

const data: VotingCreditsReturnedNotificationData = {
  event_id: 'release',
  reason: 'WIN',
  wave_id: 'wave',
  competition_id: 'competition',
  competition_title: 'The Memes - Main Stage',
  entry_id: 'entry',
  drop_id: 'drop',
  submission_title: 'Freedom To Transcend',
  credit_type: 'TDH',
  amount: 500,
  released_at: 1000
};

it('renders the released allocation and links directly to a winning entry', () => {
  expect(buildVotingCreditReturnPushNotification(data)).toMatchObject({
    body: 'Submission “Freedom To Transcend” won “The Memes - Main Stage”. 500 voting credits were returned to you.',
    data: { competition_entry_id: 'entry', competition_id: 'competition' }
  });
});
it('links author deletion to the competition without the missing entry and handles singular credits', () => {
  const message = buildVotingCreditReturnPushNotification({
    ...data,
    reason: 'AUTHOR_DELETED',
    amount: 1
  });
  expect(message.body).toContain('1 voting credit was returned to you.');
  expect(message.data).not.toHaveProperty('competition_entry_id');
});
it('respects vote settings and requires native-competition support on the device', () => {
  expect(
    isNotificationEnabledForDevice(
      IdentityNotificationCause.VOTING_CREDITS_RETURNED,
      DEFAULT_PUSH_NOTIFICATION_SETTINGS,
      true
    )
  ).toBe(true);
  expect(
    isNotificationEnabledForDevice(
      IdentityNotificationCause.VOTING_CREDITS_RETURNED,
      { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS, drop_voted: false },
      true
    )
  ).toBe(false);
  expect(
    isNotificationEnabledForDevice(
      IdentityNotificationCause.VOTING_CREDITS_RETURNED,
      DEFAULT_PUSH_NOTIFICATION_SETTINGS,
      false
    )
  ).toBe(false);
});
