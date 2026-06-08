import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type { IdentityNotificationDeserialized } from '@/notifications/identity-notifications.db';
import { UserNotificationMapper } from '@/notifications/user-notification.mapper';

describe('UserNotificationMapper', () => {
  const mapper = new UserNotificationMapper();

  const baseEntity = {
    id: 1,
    identity_id: 'recipient-1',
    additional_identity_id: 'sender-1',
    related_drop_id: 'drop-1',
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null,
    additional_data: {},
    created_at: 1000,
    read_at: null,
    visibility_group_id: null,
    wave_id: 'wave-1'
  };

  function notificationEntity(
    overrides: Partial<IdentityNotificationDeserialized>
  ): IdentityNotificationDeserialized {
    return {
      ...baseEntity,
      ...overrides
    } as IdentityNotificationDeserialized;
  }

  it('preserves wave id for all-drops and priority-alert notifications', () => {
    expect(
      mapper.mapNotifications([
        notificationEntity({
          cause: IdentityNotificationCause.ALL_DROPS,
          additional_data: {
            vote: 42
          }
        })
      ])
    ).toEqual([
      {
        id: 1,
        created_at: 1000,
        read_at: null,
        cause: IdentityNotificationCause.ALL_DROPS,
        data: {
          additional_identity_id: 'sender-1',
          drop_id: 'drop-1',
          vote: 42,
          wave_id: 'wave-1'
        }
      }
    ]);

    expect(
      mapper.mapNotifications([
        notificationEntity({
          cause: IdentityNotificationCause.PRIORITY_ALERT
        })
      ])
    ).toEqual([
      {
        id: 1,
        created_at: 1000,
        read_at: null,
        cause: IdentityNotificationCause.PRIORITY_ALERT,
        data: {
          additional_identity_id: 'sender-1',
          drop_id: 'drop-1',
          wave_id: 'wave-1'
        }
      }
    ]);
  });

  it('maps drop poll vote notifications with selected options', () => {
    const [notification] = mapper.mapNotifications([
      notificationEntity({
        identity_id: 'author-1',
        additional_identity_id: 'voter-1',
        cause: IdentityNotificationCause.DROP_POLL_VOTED,
        additional_data: {
          poll_options: [
            { option_no: '1', option_string: 'First' },
            { option_no: 3, option_string: 'Third' }
          ]
        },
        visibility_group_id: 'visibility-group',
        wave_id: 'wave-1'
      })
    ]);

    expect(notification).toEqual({
      id: 1,
      created_at: 1000,
      read_at: null,
      cause: IdentityNotificationCause.DROP_POLL_VOTED,
      data: {
        drop_author_id: 'author-1',
        drop_id: 'drop-1',
        voter_id: 'voter-1',
        poll_options: [
          { option_no: 1, option_string: 'First' },
          { option_no: 3, option_string: 'Third' }
        ],
        wave_id: 'wave-1'
      }
    });
  });
});
