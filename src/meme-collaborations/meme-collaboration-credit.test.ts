import { withCollaborationCredit } from './meme-collaboration-credit';
import {
  buildCollaborationCredit,
  collaborationArtworkHash
} from './meme-collaborations.service';
import type { CollaborationInvitation } from './meme-collaborations.db';

const credit = {
  artist: 'A, B',
  artist_profiles: 'userA, userB',
  collab: true
};
describe('Managed mint collaboration credits', () => {
  const invitation = (
    id: string,
    artistName: string | null,
    status = 'ACCEPTED'
  ) =>
    ({
      artist_name: artistName,
      status,
      profile: { id, handle: id, display: id, pfp: null }
    }) as CollaborationInvitation;
  it('uses confirmed credit names with an ampersand for two artists and comma-separated handles', () => {
    expect(
      buildCollaborationCredit('Artist A', 'userA', [
        invitation('userB', 'Artist B')
      ])
    ).toEqual({
      artist: 'Artist A & Artist B',
      artist_profiles: 'userA, userB',
      collab: true
    });
  });
  it('uses commas for three artists and excludes pending invitations', () => {
    expect(
      buildCollaborationCredit('Artist A', 'userA', [
        invitation('userB', 'Artist B'),
        invitation('userC', 'Artist C'),
        invitation('userD', 'Artist D', 'PENDING')
      ])
    ).toEqual({
      artist: 'Artist A, Artist B, Artist C',
      artist_profiles: 'userA, userB, userC',
      collab: true
    });
  });
  it('preserves solo credit and falls back for older accepted invitations without a saved name', () => {
    expect(buildCollaborationCredit('Artist A', 'userA', [])).toEqual({
      artist: 'Artist A',
      artist_profiles: 'userA',
      collab: false
    });
    expect(
      buildCollaborationCredit('Artist A', 'userA', [invitation('userB', null)])
        .artist
    ).toBe('Artist A & userB');
  });
  it('replaces declared credits with the accepted roster without losing other traits', () => {
    const attributes = withCollaborationCredit(
      [
        { trait_type: 'Artist', value: 'A, unaccepted' },
        { trait_type: 'SEIZE Artist Profile', value: 'userA, unaccepted' },
        { trait_type: 'Collab', value: 'No' },
        { trait_type: 'Palette', value: 'Color' }
      ],
      credit
    );
    expect(attributes).toContainEqual({
      trait_type: 'Palette',
      value: 'Color'
    });
    expect(attributes).toContainEqual({
      trait_type: 'SEIZE Artist Profile',
      value: 'userA, userB'
    });
    expect(attributes).toContainEqual({ trait_type: 'Artist', value: 'A, B' });
    expect(attributes).toContainEqual({ trait_type: 'Collab', value: 'Yes' });
  });
  it('binds consent to both animation and its preview image', () => {
    const model = {
      title: 'Artwork',
      parts: [
        {
          content: 'Description',
          quoted_drop: null,
          media: [
            { mime_type: 'video/mp4', url: 'https://example.com/art.mp4' }
          ]
        }
      ],
      metadata: [
        { data_key: 'artist', data_value: 'A' },
        {
          data_key: 'additional_media',
          data_value: JSON.stringify({
            preview_image: 'https://example.com/preview.png'
          })
        }
      ]
    };
    expect(collaborationArtworkHash(model)).not.toBe(
      collaborationArtworkHash({
        ...model,
        metadata: [
          model.metadata[0],
          {
            data_key: 'additional_media',
            data_value: JSON.stringify({
              preview_image: 'https://example.com/replacement.png'
            })
          }
        ]
      })
    );
  });
});
