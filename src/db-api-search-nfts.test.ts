import 'reflect-metadata';
import { searchNfts } from '@/db-api';
import {
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  NFTS_TABLE,
  NFTS_MEME_LAB_TABLE
} from '@/constants';
import { NFT, BaseNFT } from '@/entities/INFT';
import { NEXTGEN_TOKENS_TABLE } from '@/nextgen/nextgen_constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const baseNft: Omit<BaseNFT, 'id' | 'name'> = {
  contract: MEMES_CONTRACT,
  created_at: new Date('2026-01-01T00:00:00Z'),
  mint_price: 0,
  supply: 1,
  collection: 'The Memes',
  token_type: 'ERC1155',
  description: '',
  artist: '',
  artist_seize_handle: '',
  floor_price: 0,
  floor_price_from: null,
  market_cap: 0,
  total_volume_last_24_hours: 0,
  total_volume_last_7_days: 0,
  total_volume_last_1_month: 0,
  total_volume: 0,
  highest_offer: 0,
  highest_offer_from: null,
  icon: 'icon',
  thumbnail: 'thumbnail',
  image: 'image'
};

function nft(id: number, name: string | undefined): NFT {
  return {
    ...baseNft,
    id,
    name,
    edition_size_floor: 1,
    hodl_rate: 0,
    boosted_tdh: 0,
    tdh: 0,
    tdh__raw: 0,
    tdh_rank: 0
  };
}

describeWithSeed(
  'searchNfts',
  [
    {
      table: NFTS_TABLE,
      rows: [
        nft(0, 'Zero'),
        nft(1, 'Learn to trust, then check everything'),
        nft(2, "Don't trust check again"),
        nft(3, "Check that you don't trust"),
        nft(4, 'Trust the process'),
        nft(5, 'Tracing rustic thistles'),
        nft(6, "DALL-E's Revenge"),
        nft(21, 'Open Roads, Open Metaverse'),
        nft(32, "You Can't Touch This"),
        nft(75, 'No Meme, No Life'),
        nft(101, 'WAGMI: Legacy'),
        nft(103, "Don't Trust, Check."),
        nft(104, 'Checkmate'),
        nft(105, '100%_real\\art'),
        nft(106, '100xxrealxart'),
        nft(107, undefined),
        nft(108, 'Café — 東京'),
        nft(109, '𐐀rt // Worlds'),
        nft(110, 'We’re ALL–IN!'),
        nft(111, 'Art & Life: #Now!? // Together.')
      ]
    },
    {
      table: NFTS_MEME_LAB_TABLE,
      rows: [
        {
          ...baseNft,
          contract: MEMELAB_CONTRACT,
          id: 7,
          name: 'Lab: Open, Worlds!',
          meme_references: []
        }
      ]
    },
    {
      table: NEXTGEN_TOKENS_TABLE,
      rows: [
        {
          id: 10000000103,
          normalised_id: 103,
          owner: '0x0000000000000000000000000000000000000001',
          collection_id: 1,
          burnt: false,
          name: 'Pebbles #103',
          collection_name: 'Pebbles',
          mint_date: new Date('2026-01-01T00:00:00Z'),
          mint_price: 0,
          metadata_url: '',
          image_url: 'image',
          icon_url: 'icon',
          thumbnail_url: 'thumbnail',
          pending: false,
          hodl_rate: 0
        }
      ]
    }
  ],
  () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each([
      ["don't trust, check", 103],
      ["don't trust check", 103],
      ['dont trust check', 103],
      ['Dont Trust Check', 103],
      ['check trust', 103],
      ['  dont   trust\tcheck  ', 103],
      ["dall-e's revenge", 6],
      ['dalle revenge', 6],
      ['you cant touch this', 32],
      ['wagmi legacy', 101],
      ['no meme no life', 75],
      ['open roads open metaverse', 21],
      ['café 東京', 108],
      ['were allin', 110],
      ['art life now together', 111]
    ])('ranks the remembered name %s first', async (query, expectedId) => {
      const results = await searchNfts(query, 50);
      expect(results[0]).toMatchObject({
        id: expectedId,
        contract: MEMES_CONTRACT.toLowerCase()
      });
    });

    it('keeps phrase matches ahead of reordered matches before limiting', async () => {
      const results = await searchNfts('dont trust check', 2);
      expect(results.map((result) => result.id)).toEqual([103, 2]);
    });

    it('requires every term and removes preliminary-filter false positives', async () => {
      const results = await searchNfts('trust', 50);
      expect(results.map((result) => result.id)).not.toContain(5);
      const combined = await searchNfts('check trust', 50);
      expect(combined.map((result) => result.id)).not.toContain(4);
      expect(combined.map((result) => result.id)).not.toContain(104);
      await expect(searchNfts('trust nonexistent', 50)).resolves.toEqual([]);
    });

    it.each(['%trust%check%', 'trust_check', 'trust\\check', "x' OR 1=1 --"])(
      'does not interpret SQL syntax or wildcards in %s',
      async (query) => {
        await expect(searchNfts(query, 50)).resolves.toEqual([]);
      }
    );

    it.each(['100%_real\\art', '%_real', 'real\\art'])(
      'finds literal wildcard and escape characters in %s',
      async (query) => {
        const results = await searchNfts(query, 50);
        expect(results.map((result) => result.id)).toEqual([105]);
      }
    );

    it.each(['103', ' 103 ', '+103', '103.0'])(
      'preserves the NFT ID and NextGen normalized ID lookup for %s',
      async (query) => {
        const results = await searchNfts(query, 50);
        expect(results.map((result) => result.id)).toEqual([103, 10000000103]);
      }
    );

    it('preserves short numeric IDs, zero, and the full NextGen ID', async () => {
      expect((await searchNfts('0', 50)).map((row) => row.id)).toEqual([0]);
      expect((await searchNfts('6', 50)).map((row) => row.id)).toEqual([6]);
      expect(
        (await searchNfts('10000000103', 50)).map((row) => row.id)
      ).toEqual([10000000103]);
    });

    it.each(['', ' ', '\t\n', 'gm', ' a ', '!!!', '%_%', 'a!!'])(
      'returns nothing without querying the database for %j',
      async (query) => {
        const execute = jest.spyOn(sqlExecutor, 'execute');
        await expect(searchNfts(query, 50)).resolves.toEqual([]);
        expect(execute).not.toHaveBeenCalled();
      }
    );

    it.each([undefined, null, ['trust', 'check'], { name: 'trust' }])(
      'rejects absent or non-string request values: %j',
      async (query) => {
        const execute = jest.spyOn(sqlExecutor, 'execute');
        await expect(
          searchNfts(query as unknown as string, 50)
        ).resolves.toEqual([]);
        expect(execute).not.toHaveBeenCalled();
      }
    );

    it('searches Meme Lab and NextGen names with the same response shape', async () => {
      const [lab] = await searchNfts('worlds lab open', 50);
      expect(lab).toEqual({
        id: 7,
        contract: MEMELAB_CONTRACT.toLowerCase(),
        name: 'Lab: Open, Worlds!',
        icon_url: 'icon',
        thumbnail_url: 'thumbnail',
        image_url: 'image'
      });
      const [nextgen] = await searchNfts('103 pebbles', 50);
      expect(nextgen.id).toBe(10000000103);
      expect(Object.keys(nextgen).sort((a, b) => a.localeCompare(b))).toEqual([
        'contract',
        'icon_url',
        'id',
        'image_url',
        'name',
        'thumbnail_url'
      ]);
    });

    it('preserves supplementary Unicode letters', async () => {
      const results = await searchNfts('𐐀rt worlds', 50);
      expect(results.map((result) => result.id)).toEqual([109]);
    });

    it('propagates database errors instead of presenting false empty results', async () => {
      jest
        .spyOn(sqlExecutor, 'execute')
        .mockRejectedValueOnce(new Error('Database unavailable'));
      await expect(searchNfts('trust', 50)).rejects.toThrow(
        'Database unavailable'
      );
    });
  }
);
