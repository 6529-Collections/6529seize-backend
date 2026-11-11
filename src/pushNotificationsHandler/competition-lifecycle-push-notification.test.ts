import {
  buildCompetitionLifecyclePushNotification,
  competitionLifecycleMessage
} from './competition-lifecycle-push-notification';
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
      title: 'Decision update',
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

describe('decision lifecycle push copy', () => {
  const lifecycle = (event_type: string) =>
    buildCompetitionLifecyclePushNotification({
      event_id: 'event',
      event_type,
      competition_id: 'competition',
      competition_title: 'Spring Open',
      wave_id: 'wave'
    });

  it('titles every lifecycle push as a decision update', () => {
    expect(lifecycle('COMPETITION_PUBLISHED').title).toBe('Decision update');
    expect(lifecycle('UNKNOWN_EVENT').title).toBe('Decision update');
  });

  it.each([
    ['COMPETITION_PAUSED', 'Spring Open has paused results'],
    ['COMPETITION_RESUMED', 'Spring Open has resumed results'],
    ['COMPETITION_DECISION_COMPLETED', 'Spring Open has new winners'],
    ['COMPETITION_PUBLISHED', 'Spring Open is now published'],
    ['UNKNOWN_EVENT', 'Spring Open has an update']
  ])('renders %s after the decision title', (eventType, body) => {
    expect(lifecycle(eventType).body).toBe(body);
  });

  it('keeps competition and decision wording out of lifecycle phrases', () => {
    const eventTypes = [
      'COMPETITION_PUBLISHED',
      'COMPETITION_STARTED',
      'COMPETITION_SCHEDULE_CHANGED',
      'COMPETITION_PAUSED',
      'COMPETITION_RESUMED',
      'COMPETITION_UPDATED',
      'COMPETITION_CANCELLED',
      'COMPETITION_ENDED',
      'COMPETITION_DECISION_COMPLETED',
      'COMPETITION_ENTRY_STATUS_CHANGED',
      'COMPETITION_ENTRY_DISQUALIFIED',
      'UNKNOWN_EVENT'
    ];
    for (const eventType of eventTypes)
      expect(competitionLifecycleMessage(eventType)).not.toMatch(
        /competition|decision/i
      );
  });
});
