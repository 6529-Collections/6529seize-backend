import type { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import type { MemeCollaborationsDb } from './meme-collaborations.db';
import {
  collaborationArtworkHash,
  MemeCollaborationsService
} from './meme-collaborations.service';

it.each<[string, number, string | null]>([
  ['Artist A & Artist B Name', 1, null],
  ['Artist A, Artist B Name, Artist C Name', 2, null],
  ['Legacy A, Legacy B', 1, 'Legacy A, Legacy B']
])(
  'permits an unchanged presented credit round trip: %s',
  async (presented, count, frozen) => {
    const original = {
      drop_id: 'drop',
      drop_type: DropType.PARTICIPATORY,
      title: 'Artwork',
      metadata: [{ data_key: 'artist', data_value: 'Artist A' }],
      parts: [
        {
          content: 'Description',
          media: [
            { url: 'https://example.com/art.png', mime_type: 'image/png' }
          ]
        }
      ]
    } as CreateOrUpdateDropModel;
    const query = jest.fn();
    const db = {
      context: jest.fn().mockResolvedValue({
        drop_id: 'drop',
        base_artist: 'Artist A',
        artwork_hash: collaborationArtworkHash(original),
        closed_at: frozen ? 1 : null,
        credit: frozen ? { artist: frozen } : null
      }),
      invitations: jest.fn().mockResolvedValue([
        {
          status: 'ACCEPTED',
          artist_name: 'Artist B Name',
          profile: { display: 'renamedB' }
        },
        ...(count === 2
          ? [
              {
                status: 'ACCEPTED',
                artist_name: 'Artist C Name',
                profile: { display: 'renamedC' }
              }
            ]
          : [])
      ]),
      query
    };
    const service = new MemeCollaborationsService(
      db as unknown as MemeCollaborationsDb
    );
    const roundTrip = {
      ...original,
      metadata: [
        { data_key: 'artist', data_value: presented },
        { data_key: 'color', data_value: 'blue' }
      ]
    };
    await expect(service.onWrite(roundTrip, 'drop', {})).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await expect(
      service.onWrite(
        { ...roundTrip, title: 'Replacement artwork' },
        'drop',
        {}
      )
    ).rejects.toThrow('locks this artwork');
  }
);
