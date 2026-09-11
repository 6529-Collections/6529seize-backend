import fc from 'fast-check';
import {
  analyzeCollectingGoal,
  collectingAssetKey
} from '@/collecting/collecting-analysis';
import {
  CollectingAccount,
  CollectingAsset,
  CollectingCatalog,
  CollectingHolding
} from '@/collecting/collecting.types';
import { MEMES_CONTRACT, GRADIENT_CONTRACT } from '@/constants';

const walletA = '0x0000000000000000000000000000000000000011';
const walletB = '0x0000000000000000000000000000000000000022';
const outside = '0x0000000000000000000000000000000000000033';
const account: CollectingAccount = {
  profile_id: 'profile',
  consolidation_key: `${walletA}-${walletB}`,
  wallets: [walletA, walletB],
  membership_hash: 'members-v1'
};
const snapshot = { block_number: 100, nextgen_block_number: 100 };

function asset(
  id: string,
  family: CollectingAsset['family'] = 'memes',
  traits: CollectingAsset['traits'] = []
): CollectingAsset {
  const contract = family === 'memes' ? MEMES_CONTRACT : GRADIENT_CONTRACT;
  return {
    asset_key: collectingAssetKey(contract, id),
    chain_id: 1,
    contract,
    token_id: id,
    family,
    name: `Art ${id}`,
    image_url: null,
    artist_ids: ['artist'],
    season: family === 'memes' ? 1 : null,
    traits,
    hodl_rate: 1,
    tdh_eligible: true
  };
}
const card1 = asset('1');
const card2 = asset('2');
const pebble1 = asset('11', 'pebbles', [
  { trait: 'Palette', value: 'Blue' },
  { trait: 'Size', value: 'Small' },
  { trait: 'Traced', value: 'Yes' }
]);
const pebble2 = asset('12', 'pebbles', [
  { trait: 'Palette', value: 'Red' },
  { trait: 'Size', value: 'Large' },
  { trait: 'Traced', value: 'No' }
]);
const catalog: CollectingCatalog = {
  version: 'catalog-v1',
  chain_id: 1,
  assets: [card1, card2, pebble1, pebble2],
  seasons: [
    {
      id: 1,
      name: 'Season 1',
      current: true,
      asset_keys: [card1.asset_key, card2.asset_key]
    }
  ],
  artists: [
    {
      id: 'artist',
      name: 'Artist',
      asset_keys: [card1.asset_key, card2.asset_key],
      collaboration_asset_keys: [card2.asset_key]
    }
  ],
  pebbles_traits: [
    { trait: 'Palette', values: ['Blue', 'Red'] },
    { trait: 'Size', values: ['Small', 'Large'] },
    { trait: 'Traced', values: ['Yes', 'No'] }
  ],
  tdh_snapshot: {
    block_number: 100,
    block_timestamp: '2026-01-01T00:00:00.000Z'
  }
};
function holding(
  item: CollectingAsset,
  wallet: string,
  quantity = '1'
): CollectingHolding {
  return { asset_key: item.asset_key, wallet, quantity };
}

describe('account collecting analysis', () => {
  it('combines edition quantities across profile wallets for each requested set', () => {
    const result = analyzeCollectingGoal(
      catalog,
      account,
      [
        holding(card1, walletA, '2'),
        holding(card1, walletB),
        holding(card2, walletB, '2')
      ],
      snapshot,
      {
        profile_id: 'profile',
        kind: 'memes_season',
        season_id: 1,
        target_copies: '3'
      }
    );
    expect(result.requirements.map((item) => item.missing_quantity)).toEqual([
      '0',
      '1'
    ]);
    expect(result).toMatchObject({
      required_count: 2,
      satisfied_count: 1,
      complete: false
    });
  });

  it('covers all Ultimate facets using tokens in different account wallets', () => {
    const result = analyzeCollectingGoal(
      catalog,
      account,
      [holding(pebble1, walletA), holding(pebble2, walletB)],
      snapshot,
      { profile_id: 'profile', kind: 'pebbles_ultimate' }
    );
    expect(result).toMatchObject({
      required_count: 6,
      satisfied_count: 6,
      complete: true
    });
    expect(
      result.requirements.filter((requirement) =>
        requirement.holdings.some(
          (item) => item.asset_key === pebble1.asset_key
        )
      )
    ).toHaveLength(3);
  });

  it('preserves profile coverage when custody moves internally', () => {
    const request = {
      profile_id: 'profile',
      kind: 'pebbles_ultimate' as const
    };
    const before = analyzeCollectingGoal(
      catalog,
      account,
      [holding(pebble1, walletA), holding(pebble2, walletB)],
      snapshot,
      request
    );
    const after = analyzeCollectingGoal(
      catalog,
      account,
      [holding(pebble1, walletB), holding(pebble2, walletB)],
      snapshot,
      request
    );
    expect(after.satisfied_count).toBe(before.satisfied_count);
    expect(after.analysis_id).not.toBe(before.analysis_id);
  });

  it('keeps external recipients valid but does not credit future deliveries to this account', () => {
    const result = analyzeCollectingGoal(catalog, account, [], snapshot, {
      profile_id: 'profile',
      kind: 'memes_full_set',
      recipient: outside
    });
    expect(result).toMatchObject({
      recipient: outside,
      recipient_in_profile: false,
      counts_toward_profile: false,
      complete: false,
      satisfied_count: 0
    });
    const own = analyzeCollectingGoal(catalog, account, [], snapshot, {
      profile_id: 'profile',
      kind: 'memes_full_set',
      recipient: walletB
    });
    expect(own.counts_toward_profile).toBe(true);
  });

  it('uses explicit artist membership and collaboration inclusion', () => {
    const result = analyzeCollectingGoal(catalog, account, [], snapshot, {
      profile_id: 'profile',
      kind: 'memes_artist',
      artist_id: 'artist',
      include_collaborations: false
    });
    expect(result.requirements.map((requirement) => requirement.id)).toEqual([
      card1.asset_key
    ]);
  });

  it('distinguishes released and TDH-eligible full collections', () => {
    const adjusted = {
      ...catalog,
      assets: [card1, { ...card2, tdh_eligible: false }]
    };
    const result = analyzeCollectingGoal(adjusted, account, [], snapshot, {
      profile_id: 'profile',
      kind: 'memes_full_set',
      universe: 'tdh_eligible'
    });
    expect(result.required_count).toBe(1);
  });

  it('rejects changed target versions, invalid unique quantities, duplicate assets and foreign holdings', () => {
    expect(() =>
      analyzeCollectingGoal(catalog, account, [], snapshot, {
        profile_id: 'profile',
        kind: 'memes_full_set',
        catalog_version: 'old'
      })
    ).toThrow('Catalog changed');
    expect(() =>
      analyzeCollectingGoal(catalog, account, [], snapshot, {
        profile_id: 'profile',
        kind: 'exact',
        assets: [{ asset_key: pebble1.asset_key, quantity: '2' }]
      })
    ).toThrow('quantity one');
    expect(() =>
      analyzeCollectingGoal(catalog, account, [], snapshot, {
        profile_id: 'profile',
        kind: 'exact',
        assets: [
          { asset_key: card1.asset_key, quantity: '1' },
          { asset_key: card1.asset_key, quantity: '1' }
        ]
      })
    ).toThrow('repeated asset');
    expect(() =>
      analyzeCollectingGoal(
        catalog,
        account,
        [holding(card1, outside)],
        snapshot,
        { profile_id: 'profile', kind: 'memes_full_set' }
      )
    ).toThrow('inconsistent');
  });

  it('conserves deficit quantities for account balances', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, b, target) => {
          const result = analyzeCollectingGoal(
            catalog,
            account,
            [
              holding(card1, walletA, String(a)),
              holding(card1, walletB, String(b))
            ],
            snapshot,
            {
              profile_id: 'profile',
              kind: 'exact',
              assets: [{ asset_key: card1.asset_key, quantity: String(target) }]
            }
          );
          expect(result.requirements[0].missing_quantity).toBe(
            String(Math.max(0, target - a - b))
          );
        }
      )
    );
  });

  it('keeps uint256 token IDs lossless and rejects overflow', () => {
    expect(collectingAssetKey(MEMES_CONTRACT, '9007199254740993')).toContain(
      ':9007199254740993'
    );
    expect(() =>
      collectingAssetKey(
        MEMES_CONTRACT,
        '115792089237316195423570985008687907853269984665640564039457584007913129639936'
      )
    ).toThrow('Invalid token ID');
  });
});
