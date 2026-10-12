import {
  assertCollaborationCredit,
  withCollaborationCredit
} from './meme-collaboration-credit';
import { collaborationArtworkHash } from './meme-collaborations.service';

const credit = {
  artist: 'A, B',
  artist_profiles: 'userA, userB',
  collab: true
};
describe('Managed mint collaboration credits', () => {
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
    expect(() => assertCollaborationCredit(attributes, credit)).not.toThrow();
    expect(() =>
      assertCollaborationCredit(
        [...attributes, { trait_type: 'Artist', value: 'fake' }],
        credit
      )
    ).toThrow('fixed');
    expect(() =>
      assertCollaborationCredit(
        attributes.filter((item) => item.trait_type !== 'Collab'),
        credit
      )
    ).toThrow('fixed');
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
