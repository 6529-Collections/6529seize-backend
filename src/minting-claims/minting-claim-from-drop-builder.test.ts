import { MEMES_CONTRACT } from '@/constants';
import type { DropMediaEntity, DropMetadataEntity } from '@/entities/IDrop';
import { buildMintingClaimRowFromDrop } from '@/minting-claims/minting-claim-from-drop.builder';

describe('buildMintingClaimRowFromDrop', () => {
  it('uses the proposal HTML and preview without publishing its editing metadata as a trait', () => {
    const htmlUrl =
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/index.html';
    const previewUrl = 'https://example.com/preview.png';
    const row = buildMintingClaimRowFromDrop(
      'drop-proposal',
      MEMES_CONTRACT,
      1,
      [{ url: htmlUrl, mime_type: 'text/html' }] as DropMediaEntity[],
      [
        { data_key: 'title', data_value: 'Permanent Pepe' },
        {
          data_key: 'additional_media',
          data_value: JSON.stringify({ preview_image: previewUrl })
        },
        {
          data_key: 'proposal_frame',
          data_value: JSON.stringify({
            version: 1,
            layout: 'portrait',
            media_url: 'https://untrusted.example/fake.html',
            mime_type: 'text/html'
          })
        }
      ] as DropMetadataEntity[],
      14
    );
    expect(row).toMatchObject({
      animation_url: htmlUrl,
      animation_kind: 'html',
      animation_details: { format: 'HTML' },
      image_url: previewUrl
    });
    expect(row.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trait_type: 'Proposal_frame' })
      ])
    );
  });

  it('excludes internal allowlist_batches metadata from public attributes', () => {
    const metadatas: DropMetadataEntity[] = [
      {
        data_key: 'title',
        data_value: 'SEIZE PEACE'
      },
      {
        data_key: 'description',
        data_value: 'Peace is a tender thing.'
      },
      {
        data_key: 'artist',
        data_value: 'Nuclear Samurai'
      },
      {
        data_key: 'allowlist_batches',
        data_value:
          '[{"contract":"0x33fd426905f149f8376e227d0c9d3340aad17af1","token_ids":"300,395"}]'
      },
      {
        data_key: 'additional_media',
        data_value:
          '{"preview_image":"https://example.com/preview.png","promo_video":""}'
      }
    ] as DropMetadataEntity[];

    const row = buildMintingClaimRowFromDrop(
      'drop-1',
      MEMES_CONTRACT,
      472,
      [],
      metadatas,
      14
    );

    expect(row.name).toBe('SEIZE PEACE');
    expect(row.description).toBe('Peace is a tender thing.');
    expect(row.attributes).toEqual(
      expect.arrayContaining([
        {
          trait_type: 'Artist',
          value: 'Nuclear Samurai'
        },
        {
          trait_type: 'Type - Season',
          value: 14,
          display_type: 'number'
        }
      ])
    );
    expect(row.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trait_type: 'Allowlist_batches'
        })
      ])
    );
  });

  it('trims dirty drop metadata while preserving internal whitespace', () => {
    const metadatas: DropMetadataEntity[] = [
      {
        data_key: ' title ',
        data_value: ' The Loom '
      },
      {
        data_key: ' description ',
        data_value: '  Loom  description  '
      },
      {
        data_key: ' artist ',
        data_value: '  Digital  Artist  '
      },
      {
        data_key: ' custom trait ',
        data_value: '  inner  spacing  '
      },
      {
        data_key: ' empty ',
        data_value: '   '
      }
    ] as DropMetadataEntity[];

    const row = buildMintingClaimRowFromDrop(
      'drop-1',
      MEMES_CONTRACT,
      519,
      [],
      metadatas,
      15
    );

    expect(row.name).toBe('The Loom');
    expect(row.description).toBe('Loom  description');
    expect(row.attributes).toEqual(
      expect.arrayContaining([
        {
          trait_type: 'Artist',
          value: 'Digital  Artist'
        },
        {
          trait_type: 'Custom trait',
          value: 'inner  spacing'
        }
      ])
    );
    expect(row.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trait_type: 'Empty'
        })
      ])
    );
  });

  it.each([
    ['video/mp4', 'video'],
    ['model/gltf-binary', 'glb']
  ] as const)(
    'leaves %s inspection details absent until enrichment succeeds',
    (mimeType, animationKind) => {
      const row = buildMintingClaimRowFromDrop(
        'drop-1',
        MEMES_CONTRACT,
        520,
        [
          {
            mime_type: mimeType,
            url: `https://cdn.example.com/artwork.${animationKind === 'glb' ? 'glb' : 'mp4'}`
          } as any
        ],
        [],
        15
      );

      expect(row.animation_url).not.toBeNull();
      expect(row.animation_details).toBeNull();
      expect(row.animation_kind).toBe(animationKind);
    }
  );
});
