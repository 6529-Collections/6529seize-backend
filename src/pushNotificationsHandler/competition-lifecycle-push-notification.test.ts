import { buildCompetitionLifecyclePushNotification } from './competition-lifecycle-push-notification';
import { UserNotificationMapper } from '@/notifications/user-notification.mapper';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';

describe('competition notification context', () => {
  it('preserves competition and entry identity through storage mapping and push navigation', () => {
    const context = {
      event_id: 'event',
      event_type: 'COMPETITION_ENTRY_DISQUALIFIED',
      competition_id: 'competition',
      competition_title: 'Contest',
      wave_id: 'wave',
      entry_id: 'entry',
      drop_id: 'drop'
    };
    const [notification] = new UserNotificationMapper().mapNotifications([
      {
        id: 1,
        identity_id: 'artist',
        additional_identity_id: null,
        related_drop_id: null,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        additional_data: context,
        created_at: 100,
        read_at: null,
        visibility_group_id: null,
        wave_id: 'wave',
        cause: IdentityNotificationCause.COMPETITION_LIFECYCLE
      }
    ]);
    expect(notification.data).toEqual(context);
    expect(buildCompetitionLifecyclePushNotification(context)).toEqual({
      title: 'Competition update',
      body: 'Contest has a moderation update for your entry',
      data: {
        redirect: 'waves',
        wave_id: 'wave',
        competition_id: 'competition',
        competition_entry_id: 'entry'
      },
      imageUrl: null
    });
  });
});
