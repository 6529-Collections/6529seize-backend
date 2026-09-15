import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  CollectingQuotedTdhCandidate,
  rankCollectingTdhQuotes
} from '@/collecting/collecting-tdh-ranking';
import {
  CollectingTdhProjectionInput,
  CollectingTdhSource,
  projectCollectingTdh
} from '@/collecting/collecting-tdh-projection';
import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { Transaction } from '@/entities/ITransaction';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

const wallet = '0x0000000000000000000000000000000000000011';
const seller = '0x0000000000000000000000000000000000000022';
const now = Date.parse('2026-01-31T12:00:00Z');
const transaction: Transaction = {
  transaction: 'history',
  block: 1,
  transaction_date: new Date('2026-01-01T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  contract: MEMES_CONTRACT,
  token_id: 1,
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
};

function source(): CollectingTdhSource {
  const input: CollectingTdhProjectionInput = {
    snapshot_block: 100,
    snapshot_timestamp: '2026-01-31T00:00:00Z',
    rules_version: 'fixture',
    evaluated_at: '2026-01-31T00:00:00Z',
    wallets: [wallet],
    tokens: [
      ...[1, 2, 3].map((token_id) => ({
        contract: MEMES_CONTRACT,
        token_id,
        family: 'memes' as const,
        minted_at: '2025-01-01T00:00:00Z',
        hodl_rate: 1,
        calculation_edition_size: 100
      })),
      {
        contract: GRADIENT_CONTRACT,
        token_id: 1,
        family: 'gradients',
        minted_at: '2025-01-01T00:00:00Z',
        hodl_rate: 10
      }
    ],
    transactions: [transaction],
    seasons: [],
    transfers: []
  };
  return {
    account: {
      profile_id: 'profile',
      consolidation_key: wallet,
      wallets: [wallet],
      membership_hash: 'members'
    },
    input,
    official: projectCollectingTdh(input).baseline
  };
}

function quote(
  id: string,
  cost: string,
  contract = MEMES_CONTRACT,
  recipient = wallet,
  ids = [2]
): CollectingQuotedTdhCandidate {
  return {
    candidate_id: id,
    total_cost_wei: cost,
    valid_until: '2026-02-01T00:00:00Z',
    acquisitions: ids.map((id) => ({
      asset_key: collectingAssetKey(contract, String(id)),
      quantity: '1',
      recipient
    }))
  };
}

describe('marginal TDH cost ranking', () => {
  it('returns an honest empty ranking while retaining official parity and horizon validation', () => {
    const result = rankCollectingTdhQuotes(source(), 30, [], now);
    expect(result).toMatchObject({
      candidate_count: 0,
      evaluated_count: 0,
      ranked: [],
      excluded: [],
      optimality: 'best_found',
      candidate_scope: 'supplied_verified_quotes',
      evaluated_at: '2026-03-02T00:00:00.000Z'
    });
    expect(result.ranking_id).toHaveLength(64);
    expect(() =>
      rankCollectingTdhQuotes(source(), 30, [], now + 86400001)
    ).toThrow('snapshot');
    const changed = source();
    changed.official.boosted_tdh += 1;
    expect(() => rankCollectingTdhQuotes(changed, 30, [], now)).toThrow();
  });
  it('ranks by exact all-in cost per additional TDH, including changes to old holdings', () => {
    const result = rankCollectingTdhQuotes(
      source(),
      30,
      [
        quote('card', '10000'),
        quote('gradient', '30000', GRADIENT_CONTRACT, wallet, [1]),
        quote('gift', '1', MEMES_CONTRACT, seller)
      ],
      now
    );
    expect(result.ranked.map((row) => row.candidate_id)).toEqual([
      'gradient',
      'card',
      'gift'
    ]);
    expect(result.ranked[0]).toMatchObject({
      additional_tdh: 297,
      changed_boost_on_existing_holdings: 1,
      cost_per_additional_tdh: { numerator_wei: '30000', denominator_tdh: 297 }
    });
    expect(result.ranked[2].cost_per_additional_tdh).toBeNull();
    expect(result).toMatchObject({
      optimality: 'best_found',
      candidate_scope: 'supplied_verified_quotes',
      evaluated_count: 3
    });
  });

  it('evaluates a complete bundle against the original baseline instead of summing independent projections', () => {
    const fixture = source();
    fixture.input.seasons = [
      {
        id: 1,
        start_index: 1,
        end_index: 2,
        count: 2,
        boost: 0.05,
        name: 'One',
        display: 'One'
      },
      {
        id: 2,
        start_index: 3,
        end_index: 3,
        count: 1,
        boost: 0.05,
        name: 'Two',
        display: 'Two'
      }
    ];
    fixture.official = projectCollectingTdh(fixture.input).baseline;
    const result = rankCollectingTdhQuotes(
      fixture,
      30,
      [
        quote('two', '1'),
        quote('three', '1', MEMES_CONTRACT, wallet, [3]),
        quote('bundle', '2', MEMES_CONTRACT, wallet, [2, 3])
      ],
      now
    );
    const byId = new Map(
      result.ranked.map((candidate) => [candidate.candidate_id, candidate])
    );
    expect(byId.get('bundle')?.additional_tdh).toBe(63);
    expect(
      byId.get('two')!.additional_tdh + byId.get('three')!.additional_tdh
    ).toBe(62);
  });

  it('reports expired and evaluation-bounded quotes explicitly and never rounds wei to numbers', () => {
    const quotes = Array.from({ length: 130 }, (_, index) =>
      quote(String(index), String(BigInt('9007199254740993') + BigInt(index)))
    );
    quotes[129].valid_until = '2026-01-31T00:00:00Z';
    const result = rankCollectingTdhQuotes(source(), 30, quotes, now);
    expect(result.candidate_count).toBe(130);
    expect(result.evaluated_count).toBe(128);
    expect(result.ranked[0].total_cost_wei).toBe('9007199254740993');
    expect(result.excluded).toEqual([
      { candidate_id: '129', reason: 'expired' },
      { candidate_id: '128', reason: 'evaluation_bound' }
    ]);
  });
});
