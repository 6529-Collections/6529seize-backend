import 'reflect-metadata';
import { CollectingDb } from '@/collecting/collecting.db';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { assertCollectingTdhParity } from '@/collecting/collecting-tdh-projection';
import {
  ADDRESS_CONSOLIDATION_KEY,
  ARTISTS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  NFTS_TABLE,
  NFT_OWNERS_TABLE,
  NFT_OWNERS_SYNC_STATE_TABLE,
  NULL_ADDRESS,
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { NFT } from '@/entities/INFT';
import { Transaction } from '@/entities/ITransaction';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const seller = '0x0000000000000000000000000000000000000033';
const key = `${walletA}-${walletB}`;

function nft(id: number): NFT {
  return {
    id,
    contract: MEMES_CONTRACT,
    created_at: new Date('2025-01-01T00:00:00Z'),
    mint_date: new Date('2025-01-01T00:00:00Z'),
    supply: 1,
    edition_size_floor: 500,
    name: `Card ${id}`,
    mint_price: 0,
    collection: 'Memes',
    token_type: 'ERC1155',
    description: '',
    artist: 'Artist',
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
    hodl_rate: 99,
    boosted_tdh: 0,
    tdh: 0,
    tdh__raw: 0,
    tdh_rank: 0
  };
}

function transaction(
  id: number,
  quantity: number,
  from: string,
  to: string,
  date: string,
  block: number
): Transaction {
  return {
    transaction: `tx-${id}-${date}-${to}`,
    block,
    created_at: new Date(date),
    transaction_date: new Date(date),
    contract: MEMES_CONTRACT,
    token_id: id,
    token_count: quantity,
    from_address: from,
    to_address: to,
    value: 0,
    primary_proceeds: 0,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0,
    eth_price_usd: 0,
    value_usd: 0,
    gas_usd: 0
  };
}

// The legacy artist index is not managed by TypeORM. Provision only the selected
// legacy columns in the isolated test database, never in an application path.
beforeEach(async () => {
  await sqlExecutor.execute(
    `CREATE TABLE IF NOT EXISTS ${ARTISTS_TABLE} (name VARCHAR(255) PRIMARY KEY, memes JSON NOT NULL)`
  );
});

describeWithSeed(
  'collecting canonical SQL sources',
  [
    withIdentities([
      anIdentity(
        {},
        {
          consolidation_key: key,
          profile_id: 'profile',
          primary_address: walletA,
          handle: 'Collector'
        }
      )
    ]),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: walletA, consolidation_key: key },
        { address: walletB, consolidation_key: key }
      ]
    },
    {
      table: NFTS_TABLE,
      rows: [
        nft(1),
        nft(2),
        { ...nft(3), mint_date: new Date('2026-01-30T12:00:00Z') }
      ]
    },
    {
      table: ARTISTS_TABLE,
      rows: [
        {
          name: 'Artist',
          memes: [
            { id: 1, collboration_with: [] },
            { id: 2, collboration_with: ['Partner'] }
          ]
        }
      ]
    },
    {
      table: TDH_BLOCKS_TABLE,
      rows: [
        {
          block_number: 100,
          timestamp: new Date('2026-01-31T00:00:00Z'),
          merkle_root: null
        }
      ]
    },
    {
      table: NFT_OWNERS_SYNC_STATE_TABLE,
      rows: [{ id: 1, block_reference: 110 }]
    },
    {
      table: NFT_OWNERS_TABLE,
      rows: [walletA, walletB].map((wallet) => ({
        contract: MEMES_CONTRACT,
        token_id: 1,
        wallet,
        balance: 1,
        block_reference: 110
      }))
    },
    {
      table: TRANSACTIONS_TABLE,
      rows: [
        transaction(1, 1000, NULL_ADDRESS, seller, '2025-01-01T00:00:00Z', 1),
        transaction(2, 1235, NULL_ADDRESS, seller, '2025-01-01T00:00:00Z', 1),
        transaction(1, 1, seller, walletA, '2026-01-01T00:00:00Z', 10),
        transaction(1, 1, seller, walletB, '2026-01-21T00:00:00Z', 20),
        transaction(1, 1, seller, walletA, '2026-02-01T00:00:00Z', 110)
      ]
    },
    withTdhConsolidations([
      aTdhConsolidation([walletA, walletB], {
        block: 100,
        tdh: 49,
        boosted_tdh: 49,
        boost: 1,
        memes_cards_sets: 0,
        memes: [
          {
            id: 1,
            balance: 2,
            tdh: 49,
            hodl_rate: 1.24,
            tdh__raw: 40,
            days_held_per_edition: [30, 10]
          }
        ]
      })
    ])
  ],
  () => {
    const db = new CollectingDb(dbSupplier);
    it('normalizes real SQL timestamp serialization and separates released from TDH-eligible cards', async () => {
      const catalog = await db.readCatalog();
      expect(catalog.tdh_snapshot?.block_timestamp).toBe(
        '2026-01-31T00:00:00.000Z'
      );
      expect(catalog.assets).toHaveLength(3);
      expect(
        catalog.assets.find((asset) => asset.token_id === '3')?.tdh_eligible
      ).toBe(false);
      expect(catalog.artists[0].asset_keys).toHaveLength(2);
      expect(catalog.artists[0].collaboration_asset_keys).toEqual([
        collectingAssetKey(MEMES_CONTRACT, '2')
      ]);
    });

    it('returns confirmed full-profile holdings with exact custody quantities and separate cursors', async () => {
      const result = await db.readAccountHoldings('profile');
      expect(result.account.wallets).toEqual([walletA, walletB]);
      expect(
        result.holdings.map((holding) => [holding.wallet, holding.quantity])
      ).toEqual([
        [walletA, '1'],
        [walletB, '1']
      ]);
      expect(result.snapshot).toEqual({
        block_number: 110,
        nextgen_block_number: null
      });
    });

    it('reconstructs exact supply rates and per-wallet rounding at the official block', async () => {
      const source = await db.readTdhProjectionSource('profile');
      expect(source.input.transactions).toHaveLength(2);
      expect(
        source.input.tokens.find((token) => token.token_id === 1)
          ?.calculation_edition_size
      ).toBe(1000);
      expect(() =>
        assertCollectingTdhParity(source.input, source.official)
      ).not.toThrow();
      expect(source.official.tokens?.[0]).toMatchObject({
        base_tdh: 49,
        raw_days_held: 40,
        hodl_rate: 1.24,
        balance: 2
      });
    });

    it('fails closed while canonical membership is changing', async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE address = :wallet`,
        { wallet: walletB }
      );
      await expect(db.readAccountHoldings('profile')).rejects.toThrow(
        'membership is updating'
      );
      await expect(db.readTdhProjectionSource('profile')).rejects.toThrow(
        'membership is updating'
      );
    });

    it.each([{}, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
      'rejects malformed official token identifiers as unavailable server data: %j',
      async (id) => {
        await sqlExecutor.execute(
          `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET memes = :memes WHERE consolidation_key = :key`,
          {
            key,
            memes: JSON.stringify([
              { id, balance: 2, tdh: 49, hodl_rate: 1.24, tdh__raw: 40 }
            ])
          }
        );
        await expect(db.readTdhProjectionSource('profile')).rejects.toThrow(
          'Official TDH token snapshot is invalid'
        );
      }
    );

    it('does not forecast from source inputs that differ from official token-level output', async () => {
      await sqlExecutor.execute(
        `UPDATE ${NFTS_TABLE} SET edition_size_floor = 2000 WHERE id = 1 AND contract = :contract`,
        { contract: MEMES_CONTRACT }
      );
      const source = await db.readTdhProjectionSource('profile');
      expect(() =>
        assertCollectingTdhParity(source.input, source.official)
      ).toThrow('official snapshot');
    });
  }
);
