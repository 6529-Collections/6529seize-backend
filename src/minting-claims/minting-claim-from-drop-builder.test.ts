import { MEMES_CONTRACT } from '@/constants';
import type { DropMetadataEntity } from '@/entities/IDrop';
import { buildMintingClaimRowFromDrop } from '@/minting-claims/minting-claim-from-drop.builder';

describe('buildMintingClaimRowFromDrop', () => {
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
});
