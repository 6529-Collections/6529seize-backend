import { CompetitionLifecycleNotificationData } from '@/notifications/user-notification.types';

export function competitionLifecycleMessage(eventType: string): string {
  const messages: Record<string, string> = {
    COMPETITION_PUBLISHED: 'is now published',
    COMPETITION_STARTED: 'has started',
    COMPETITION_SCHEDULE_CHANGED: 'has an updated schedule',
    COMPETITION_PAUSED: 'has paused decisions',
    COMPETITION_RESUMED: 'has resumed decisions',
    COMPETITION_UPDATED: 'has an updated schedule',
    COMPETITION_CANCELLED: 'was cancelled',
    COMPETITION_ENDED: 'has ended',
    COMPETITION_DECISION_COMPLETED: 'has new winners',
    COMPETITION_ENTRY_STATUS_CHANGED: 'has a moderation update for your entry',
    COMPETITION_ENTRY_DISQUALIFIED: 'has a moderation update for your entry'
  };
  return messages[eventType] ?? 'has an update';
}

export function buildCompetitionLifecyclePushNotification(
  data: CompetitionLifecycleNotificationData
) {
  return {
    title: 'Competition update',
    body: `${data.competition_title} ${competitionLifecycleMessage(data.event_type)}`,
    data: {
      redirect: 'waves',
      wave_id: data.wave_id,
      competition_id: data.competition_id,
      ...(data.entry_id ? { competition_entry_id: data.entry_id } : {})
    },
    imageUrl: null
  };
}
