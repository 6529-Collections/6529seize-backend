import { selectSentryAlertAllDropsSubscriberIds } from './sentry-alert-notification-recipients';

describe('selectSentryAlertAllDropsSubscriberIds', () => {
  it('selects only followers subscribed to notifications for every drop', () => {
    expect(
      selectSentryAlertAllDropsSubscriberIds([
        {
          identity_id: 'following-only',
          subscribed_to_all_drops: false
        },
        {
          identity_id: 'all-drops-subscriber',
          subscribed_to_all_drops: true
        }
      ])
    ).toEqual(['all-drops-subscriber']);
  });
});
