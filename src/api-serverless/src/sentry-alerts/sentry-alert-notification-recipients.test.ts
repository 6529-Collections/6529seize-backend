import { selectSentryAlertAllDropsSubscriberIds } from './sentry-alert-notification-recipients';

describe('selectSentryAlertAllDropsSubscriberIds', () => {
  it('returns no recipients when the wave has no followers', () => {
    expect(selectSentryAlertAllDropsSubscriberIds([])).toEqual([]);
  });

  it('returns no recipients when no follower enabled all-drops notifications', () => {
    expect(
      selectSentryAlertAllDropsSubscriberIds([
        {
          identity_id: 'following-only-1',
          subscribed_to_all_drops: false
        },
        {
          identity_id: 'following-only-2',
          subscribed_to_all_drops: false
        }
      ])
    ).toEqual([]);
  });

  it('selects only followers subscribed to notifications for every drop', () => {
    expect(
      selectSentryAlertAllDropsSubscriberIds([
        {
          identity_id: 'following-only',
          subscribed_to_all_drops: false
        },
        {
          identity_id: 'all-drops-subscriber-1',
          subscribed_to_all_drops: true
        },
        {
          identity_id: 'all-drops-subscriber-2',
          subscribed_to_all_drops: true
        }
      ])
    ).toEqual(['all-drops-subscriber-1', 'all-drops-subscriber-2']);
  });
});
