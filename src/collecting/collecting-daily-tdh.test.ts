import {
  createCollectingDailyTdhPlanner,
  CollectingDailyTdhRequest
} from '@/collecting/collecting-daily-tdh';
import {
  CollectingTdhProjectionInput,
  CollectingTdhSource,
  projectCollectingTdh
} from '@/collecting/collecting-tdh-projection';
import { CollectingTdhTargetCandidate } from '@/collecting/collecting-tdh-target.types';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { MEMES_CONTRACT, GRADIENT_CONTRACT } from '@/constants';
import { Transaction } from '@/entities/ITransaction';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

const wallet = '0x0000000000000000000000000000000000000011';
const seller = '0x0000000000000000000000000000000000000022';
const fren = '0x0000000000000000000000000000000000000033';
const now = Date.parse('2026-01-31T12:00:00Z');
const key = (id: number) => collectingAssetKey(MEMES_CONTRACT, String(id));
function fixture(owned = [1, 2]): CollectingTdhSource {
  const input: CollectingTdhProjectionInput = {
    snapshot_block: 100,
    snapshot_timestamp: '2026-01-31T00:00:00Z',
    evaluated_at: '2026-01-31T00:00:00Z',
    rules_version: 'fixture',
    wallets: [wallet],
    tokens: [1, 2, 3, 4, 5, 6].map((token_id) => ({
      contract: MEMES_CONTRACT,
      token_id,
      family: 'memes',
      minted_at: '2025-01-01T00:00:00Z',
      hodl_rate: 99,
      calculation_edition_size: 100
    })),
    seasons: [
      {
        id: 1,
        name: 'Season 1',
        display: 'S1',
        start_index: 1,
        end_index: 4,
        count: 4,
        boost: 0.05
      },
      {
        id: 2,
        name: 'Season 2',
        display: 'S2',
        start_index: 5,
        end_index: 6,
        count: 2,
        boost: 0.05
      }
    ],
    transactions: owned.map(
      (token_id) =>
        ({
          transaction: `history-${token_id}`,
          block: 1,
          created_at: new Date('2026-01-01T00:00:00Z'),
          transaction_date: new Date('2026-01-01T00:00:00Z'),
          contract: MEMES_CONTRACT,
          token_id,
          token_count: 1,
          from_address: seller,
          to_address: wallet,
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
        }) satisfies Transaction
    ),
    transfers: []
  };
  return {
    account: {
      profile_id: 'profile',
      consolidation_key: wallet,
      wallets: [wallet],
      membership_hash: 'membership'
    },
    input,
    official: projectCollectingTdh(input).baseline
  };
}
const request = (
  extra: Partial<CollectingDailyTdhRequest> = {}
): CollectingDailyTdhRequest => ({
  profile_id: 'profile',
  recipient: wallet,
  families: ['memes', 'gradients', 'pebbles'],
  mode: 'BASE_TDH_TARGET',
  target_base_tdh_per_day_hundredths: '200',
  ...extra
});
const candidate = (
  id: number,
  extra: Partial<CollectingTdhTargetCandidate> = {}
): CollectingTdhTargetCandidate => ({
  id: `order-${id}`,
  asset_key: key(id),
  maker: seller,
  quantity_step: 1,
  available_quantity: 1,
  step_cost_wei: '100',
  step_fees_wei: '5',
  ...extra
});
function plan(
  source: CollectingTdhSource,
  body: CollectingDailyTdhRequest,
  candidates: CollectingTdhTargetCandidate[],
  at = now
) {
  return createCollectingDailyTdhPlanner(
    source,
    body,
    at,
    new CollectingWorkBudget()
  )(candidates);
}

it('replays a completed season as a whole and separates daily rate from existing TDH revaluation', () => {
  const result = plan(fixture(), request(), [candidate(3), candidate(4)]);
  expect(result.base_tdh_per_day_hundredths).toBe('200');
  expect(result.personal_effects).toMatchObject({
    baseline_boost: 1,
    proposed_boost: 1.05,
    baseline_base_tdh_per_day_hundredths: '200',
    proposed_base_tdh_per_day_hundredths: '400',
    additional_boosted_tdh_per_day_ten_thousandths: '22000',
    changed_boost_on_existing_tdh: 4
  });
});

it('does not add another first-full-set bonus on top of completed seasons', () => {
  const result = plan(fixture([1, 2, 3, 4]), request(), [
    candidate(5),
    candidate(6)
  ]);
  expect(result.personal_effects).toMatchObject({
    baseline_boost: 1.05,
    proposed_boost: 1.05,
    changed_boost_on_existing_tdh: 0,
    additional_boosted_tdh_per_day_ten_thousandths: '21000'
  });
});

it('does not award current-season partial boosts before the first full-set branch', () => {
  const source = fixture([1, 2, 3, 4, 5]);
  source.input.seasons = [
    {
      id: 1,
      name: 'Season 1',
      display: 'S1',
      start_index: 1,
      end_index: 6,
      count: 6,
      boost: 0.05
    }
  ];
  source.input.transactions.forEach((transaction) => {
    transaction.token_count = 20;
  });
  source.official = projectCollectingTdh(source.input).baseline;
  const result = plan(
    source,
    request({ target_base_tdh_per_day_hundredths: '100' }),
    [candidate(6)]
  );
  expect(result.personal_effects).toMatchObject({
    baseline_boost: 1,
    proposed_boost: 1,
    additional_boosted_tdh_per_day_ten_thousandths: '10000',
    changed_boost_on_existing_tdh: 0
  });
});

it('keeps a fren purchase selectable but gives the requesting profile no benefit', () => {
  const result = plan(fixture(), request({ recipient: fren }), [
    candidate(3),
    candidate(4)
  ]);
  expect(result.selected).toHaveLength(2);
  expect(result.base_tdh_per_day_hundredths).toBe('200');
  expect(result.personal_effects).toMatchObject({
    counts_toward_profile: false,
    baseline_boost: 1,
    proposed_boost: 1,
    additional_boosted_tdh_per_day_ten_thousandths: '0',
    changed_boost_on_existing_tdh: 0
  });
});

it('reports a nominal full-day rate even when the next UTC snapshot has no new accrued days', () => {
  const source = fixture();
  const result = plan(
    source,
    request(),
    [candidate(3), candidate(4)],
    Date.parse('2026-01-31T23:59:00Z')
  );
  expect(result.base_tdh_per_day_hundredths).toBe('200');
  const projection = projectCollectingTdh({
    ...source.input,
    evaluated_at: '2026-02-01T00:00:00Z',
    transfers: [3, 4].map((token_id) => ({
      contract: MEMES_CONTRACT,
      token_id,
      from_address: seller,
      to_address: wallet,
      quantity: 1,
      timestamp: result.acquisition_timestamp
    }))
  });
  expect(projection.additional_base_tdh).toBe(0);
});

it('uses the canonical mint eligibility gate and edition calculation rate', () => {
  const source = fixture();
  source.input.tokens[5].minted_at = '2026-01-31T00:00:00Z';
  source.official = projectCollectingTdh(source.input).baseline;
  const result = plan(source, request(), [candidate(6)]);
  expect(result.selected).toEqual([]);
  expect(result.base_tdh_per_day_hundredths).toBe('0');
});

it('applies a Gradient boost to existing holdings while adding its indexed base rate', () => {
  const source = fixture();
  source.input.tokens.push({
    contract: GRADIENT_CONTRACT,
    token_id: 1,
    family: 'gradients',
    minted_at: '2025-01-01T00:00:00Z',
    hodl_rate: 2.345
  });
  source.official = projectCollectingTdh(source.input).baseline;
  const result = plan(source, request(), [
    candidate(10, { asset_key: collectingAssetKey(GRADIENT_CONTRACT, '1') })
  ]);
  expect(result.base_tdh_per_day_hundredths).toBe('235');
  expect(result.personal_effects).toMatchObject({
    proposed_boost: 1.02,
    additional_boosted_tdh_per_day_ten_thousandths: '24370'
  });
});

it('excludes every consolidated wallet seller before solving', () => {
  const result = plan(fixture(), request(), [
    candidate(3, { maker: wallet }),
    candidate(4)
  ]);
  expect(result.base_tdh_per_day_hundredths).toBe('100');
  expect(result.selected.map((entry) => entry.candidate.id)).toEqual([
    'order-4'
  ]);
});

it('fails closed on stale snapshots, mismatched official TDH and another profile', () => {
  expect(() => plan(fixture(), request(), [], now + 2 * 86400000)).toThrow(
    'recent official'
  );
  const source = fixture();
  source.official.boosted_tdh++;
  expect(() => plan(source, request(), [])).toThrow('reproduce');
  expect(() => plan(fixture(), request({ profile_id: 'another' }), [])).toThrow(
    'profile'
  );
  expect(() =>
    plan(
      fixture(),
      request({ recipient: '0x0000000000000000000000000000000000000000' }),
      []
    )
  ).toThrow('recipient');
});

it('charges hypothetical per-copy and inventory-validation work before a large replay', () => {
  const source = fixture();
  source.input.tokens = Array.from({ length: 40 }, (_, index) => ({
    ...source.input.tokens[0],
    token_id: index + 1
  }));
  source.official = projectCollectingTdh(source.input).baseline;
  expect(() =>
    plan(
      source,
      request({ target_base_tdh_per_day_hundredths: '999999999' }),
      source.input.tokens.map((token) =>
        candidate(token.token_id, { available_quantity: 9999 })
      )
    )
  ).toThrow('selected basket exceeds');
});
