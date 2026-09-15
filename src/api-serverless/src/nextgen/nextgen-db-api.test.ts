import 'reflect-metadata';
import { ADDRESS_CONSOLIDATION_KEY } from '@/constants';
import { NextgenTraitSetsDb } from '@/collecting/nextgen-trait-sets.db';
import {
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE
} from '@/nextgen/nextgen_constants';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const walletC = '0x0000000000000000000000000000000000000033';
const walletD = '0x0000000000000000000000000000000000000044';
const account = `${walletA}-${walletB}`;

function token(id: number, owner: string, collectionId = 1, burnt = false) {
  return {
    id,
    owner,
    collection_id: collectionId,
    burnt,
    normalised_id: id,
    name: `Pebble ${id}`,
    collection_name: 'Pebbles',
    mint_date: new Date('2025-01-01T00:00:00Z'),
    mint_price: 0,
    metadata_url: '',
    image_url: '',
    pending: false,
    hodl_rate: 1
  };
}

function traits(tokenId: number, values: string[], collectionId = 1) {
  return ['Palette', 'Size', 'Traced'].map((trait, index) => ({
    token_id: tokenId,
    collection_id: collectionId,
    trait,
    value: values[index],
    rarity_score: 0,
    rarity_score_rank: 0,
    rarity_score_normalised: 0,
    rarity_score_normalised_rank: 0,
    rarity_score_trait_count_normalised: 0,
    rarity_score_trait_count_normalised_rank: 0,
    statistical_rarity: 0,
    statistical_rarity_rank: 0,
    statistical_rarity_normalised: 0,
    statistical_rarity_normalised_rank: 0,
    single_trait_rarity_score_normalised: 0,
    single_trait_rarity_score_normalised_rank: 0,
    token_count: 6
  }));
}

const identities = [
  anIdentity(
    {},
    {
      consolidation_key: account,
      profile_id: 'account-one',
      primary_address: walletA,
      handle: 'Collector'
    }
  ),
  anIdentity(
    {},
    {
      consolidation_key: walletC,
      profile_id: 'account-two',
      primary_address: walletC,
      handle: 'Another'
    }
  )
];

describeWithSeed(
  'NextGen account trait sets',
  [
    withIdentities(identities),
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: walletA, consolidation_key: account },
        { address: walletB, consolidation_key: account },
        { address: walletC, consolidation_key: walletC }
      ]
    },
    {
      table: NEXTGEN_TOKENS_TABLE,
      rows: [
        token(1, walletA),
        token(2, walletB),
        token(3, walletB),
        token(4, walletC),
        token(5, walletD),
        token(6, walletC, 2),
        token(7, walletA, 1, true)
      ]
    },
    {
      table: NEXTGEN_TOKEN_TRAITS_TABLE,
      rows: [
        ...traits(1, ['Blue, sky', 'Small', 'Yes']),
        ...traits(2, ['Red', 'Large', 'No']),
        ...traits(3, ['Blue, sky', 'Small', 'No']),
        ...traits(4, ['Blue, sky', 'Small', 'Yes']),
        ...traits(5, ['Red', 'Large', 'No']),
        ...traits(6, ['Alien', 'Huge', 'Maybe'], 2),
        ...traits(7, ['Red', 'Large', 'No'])
      ]
    }
  ],
  () => {
    const db = new NextgenTraitSetsDb(dbSupplier);
    const request = {
      collectionId: 1,
      traits: ['Palette'],
      page: 1,
      pageSize: 25,
      ultimate: false
    };

    it('unions coverage across account wallets without counting duplicate values and retains custody', async () => {
      const result = await db.find(request);
      expect(result.count).toBe(3);
      expect(result.data[0]).toMatchObject({
        account_key: account,
        profile_id: 'account-one',
        owner: walletA,
        distinct_values_count: 2,
        custody_wallets: [walletA, walletB]
      });
      expect(result.data[0].token_values).toEqual([
        {
          value: 'Blue, sky',
          tokens: [1, 3],
          token_owners: [
            { token_id: 1, wallet: walletA },
            { token_id: 3, wallet: walletB }
          ]
        },
        {
          value: 'Red',
          tokens: [2],
          token_owners: [{ token_id: 2, wallet: walletB }]
        }
      ]);
    });

    it('completes Ultimate only when every required facet is covered across the account', async () => {
      const result = await db.find({
        ...request,
        traits: ['Palette', 'Size', 'Traced'],
        ultimate: true
      });
      expect(result.count).toBe(1);
      expect(result.data[0]).toMatchObject({
        account_key: account,
        palette_sets: 2,
        size_sets: 2,
        traced_sets: 2
      });
    });

    it('preserves completion through an internal custody transfer', async () => {
      await sqlExecutor.execute(
        `UPDATE ${NEXTGEN_TOKENS_TABLE} SET owner = :owner WHERE id = 1`,
        { owner: walletB }
      );
      const result = await db.find(request);
      expect(result.data[0].distinct_values_count).toBe(2);
      expect(result.data[0].custody_wallets).toEqual([walletB]);
    });

    it('counts and paginates accounts rather than wallets, including unprofiled singleton accounts', async () => {
      const first = await db.find({ ...request, pageSize: 1 });
      const second = await db.find({ ...request, pageSize: 1, page: 2 });
      const third = await db.find({ ...request, pageSize: 1, page: 3 });
      expect(first.count).toBe(3);
      expect(first.next).toBe(true);
      expect(second.data[0].account_key).toBe(walletC);
      expect(third).toMatchObject({
        count: 3,
        next: false,
        data: [{ account_key: walletD, profile_id: null }]
      });
    });

    it('searches a custody member and returns the complete account coverage', async () => {
      const result = await db.find({
        ...request,
        search: walletB,
        addresses: [walletB]
      });
      expect(result.count).toBe(1);
      expect(
        result.data[0].token_values.flatMap((value) => value.tokens)
      ).toEqual([1, 3, 2]);
    });

    it('returns no Ultimate result for an absent trait', async () => {
      expect(
        await db.find({
          ...request,
          traits: ['Palette', 'Missing'],
          ultimate: true
        })
      ).toMatchObject({ count: 0, data: [] });
    });
  }
);
