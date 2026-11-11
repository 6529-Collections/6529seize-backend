import type { MemeCollaborationNotificationData } from '@/notifications/user-notification.types';

export function buildMemeCollaborationPushNotification(
  data: MemeCollaborationNotificationData,
  dropSerialNo: number | null,
  actor: { handle?: string | null; pfp?: string | null } | null
) {
  const name = actor?.handle || 'An artist';
  const artwork = data.artwork_name?.trim() || 'an artwork';
  const actions = {
    INVITED: 'invited you to collaborate on',
    ACCEPTED: 'accepted your collaboration invitation for',
    CANCELLED: 'cancelled your collaboration invitation for'
  };
  return {
    title: 'The Memes collaboration',
    body: `${name} ${actions[data.event_type] ?? 'updated the collaboration invitation for'} ${artwork}.`,
    data: { redirect: 'waves', wave_id: data.wave_id, drop_id: dropSerialNo },
    imageUrl: actor?.pfp ?? null
  };
}
