import { buildArtistArtworkPushNotification } from './artist-artwork-push-notification';

describe('Artist artwork push', () => {
  it.each(['A new work', null, '  '])(
    'links directly to the submission with title %s',
    (artwork_title) => {
      const result = buildArtistArtworkPushNotification(
        {
          artist_id: 'artist',
          wave_id: 'wave',
          drop_id: 'drop',
          competition_id: 'competition',
          entry_id: 'entry',
          artwork_title,
          competition_title: 'The Memes – Main Stage',
          submitted_at: 100
        },
        { handle: 'Bicasso' }
      );
      expect(result.body).toBe(
        `Bicasso submitted ${artwork_title?.trim() ? '“A new work”' : 'new artwork'} to The Memes – Main Stage.`
      );
      expect(result.data).toEqual({
        redirect: 'waves',
        wave_id: 'wave',
        competition_id: 'competition',
        competition_entry_id: 'entry'
      });
    }
  );
});
