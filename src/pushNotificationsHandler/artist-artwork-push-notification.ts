import type { ArtistArtworkNotificationData } from '@/notifications/user-notification.types';

export function buildArtistArtworkPushNotification(
  data: ArtistArtworkNotificationData,
  artist: { handle: string | null }
) {
  const artwork = data.artwork_title?.trim();
  const artworkLabel = artwork ? `“${artwork}”` : 'new artwork';
  return {
    title: 'New artwork',
    body: `${artist.handle ?? 'An artist'} submitted ${artworkLabel} to ${data.competition_title}.`,
    data: {
      redirect: 'waves',
      wave_id: data.wave_id,
      competition_id: data.competition_id,
      competition_entry_id: data.entry_id
    },
    imageUrl: null
  };
}
