import { CollectingAnalysis } from '@/collecting/collecting.types';
import fc from 'fast-check';
import {
  CollectingCandidate,
  planCollectingAcquisitions
} from '@/collecting/collecting-planner';

function analysis(
  requirements: Array<{ assets: string[]; missing?: string }>,
  ownRecipient = true
): CollectingAnalysis {
  return {
    analysis_id: 'analysis',
    catalog_version: 'v1',
    account: {
      profile_id: 'profile',
      consolidation_key: 'wallet',
      wallets: ['wallet'],
      membership_hash: 'members'
    },
    holdings_snapshot: { block_number: 100, nextgen_block_number: 100 },
    kind: 'exact',
    target_copies: '1',
    requirements: requirements.map((requirement, index) => ({
      id: String(index),
      label: String(index),
      target_quantity: requirement.missing ?? '1',
      owned_quantity: '0',
      missing_quantity: requirement.missing ?? '1',
      asset_keys: requirement.assets,
      holdings: []
    })),
    required_count: requirements.length,
    satisfied_count: 0,
    complete: false,
    missing_asset_keys: requirements.flatMap(
      (requirement) => requirement.assets
    ),
    recipient: ownRecipient ? 'wallet' : 'other',
    recipient_in_profile: ownRecipient,
    counts_toward_profile: ownRecipient
  };
}

function candidate(
  id: string,
  asset: string,
  price: string,
  extra: Partial<CollectingCandidate> = {}
): CollectingCandidate {
  return {
    candidate_id: id,
    order_id: id,
    asset_key: asset,
    quantity_available: '1',
    unit_price_wei: price,
    execution_group: id,
    group_cost_wei: '0',
    inventory_key: id,
    inventory_quantity: '1',
    valid_until: '2026-01-02T00:00:00Z',
    ...extra
  };
}

const options = { evaluated_at: '2026-01-01T00:00:00Z' };

describe('collecting acquisition planner', () => {
  it('matches exhaustive basket costs and coverage on small overlapping universes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cost: fc.integer({ min: 1, max: 30 }),
            covers: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 })
          }),
          { minLength: 1, maxLength: 6 }
        ),
        (rows) => {
          const requirements = [0, 1, 2].map((index) => ({
            assets: rows.flatMap((row, id) =>
              row.covers[index] ? [`asset-${id}`] : []
            )
          }));
          const candidates = rows.map((row, id) =>
            candidate(String(id), `asset-${id}`, String(row.cost), {
              execution_group: `group-${id % 2}`,
              group_cost_wei: '4'
            })
          );
          let expectedCoverage = -1;
          let expectedCost = Number.POSITIVE_INFINITY;
          for (let mask = 0; mask < 2 ** rows.length; mask++) {
            const selected = rows.flatMap((row, index) =>
              mask & (1 << index) ? [{ row, index }] : []
            );
            const coverage = [0, 1, 2].filter((index) =>
              selected.some(({ row }) => row.covers[index])
            ).length;
            const cost =
              selected.reduce((sum, { row }) => sum + row.cost, 0) +
              new Set(selected.map(({ index }) => index % 2)).size * 4;
            if (
              coverage > expectedCoverage ||
              (coverage === expectedCoverage && cost < expectedCost)
            ) {
              expectedCoverage = coverage;
              expectedCost = cost;
            }
          }
          const result = planCollectingAcquisitions(
            analysis(requirements),
            candidates,
            options
          );
          expect(result.projected_profile_satisfied_count).toBe(
            expectedCoverage
          );
          expect(result.total_cost_wei).toBe(String(expectedCost));
          expect(result.optimality).toBe('proven_within_candidates');
        }
      ),
      { numRuns: 100 }
    );
  });
  it('proves the cheapest independent 500-card full-set plan without a small candidate cap', () => {
    const keys = Array.from({ length: 500 }, (_, index) => `card-${index}`);
    const result = planCollectingAcquisitions(
      analysis(keys.map((asset) => ({ assets: [asset] }))),
      keys.flatMap((asset) => [
        candidate(`${asset}-a`, asset, '3'),
        candidate(`${asset}-b`, asset, '1', { group_cost_wei: '1' })
      ]),
      options
    );
    expect(result).toMatchObject({
      status: 'complete',
      total_cost_wei: '1000',
      optimality: 'proven_within_candidates',
      candidate_count: 1000
    });
    expect(result.legs).toHaveLength(500);
  });

  it('preserves full candidate coverage while labeling larger overlapping sets as best found', () => {
    const keys = Array.from({ length: 200 }, (_, index) => `pebble-${index}`);
    const result = planCollectingAcquisitions(
      analysis([{ assets: keys }, { assets: keys }]),
      keys.map((asset, index) => candidate(asset, asset, String(index + 1))),
      options
    );
    expect(result).toMatchObject({
      status: 'complete',
      total_cost_wei: '1',
      optimality: 'best_found',
      candidate_count: 200
    });
  });
  it('buys one overlapping Pebble instead of independently buying each missing value', () => {
    const result = planCollectingAcquisitions(
      analysis([{ assets: ['blue', 'both'] }, { assets: ['large', 'both'] }]),
      [
        candidate('a', 'blue', '5'),
        candidate('b', 'large', '5'),
        candidate('c', 'both', '8')
      ],
      options
    );
    expect(result).toMatchObject({
      status: 'complete',
      total_cost_wei: '8',
      optimality: 'proven_within_candidates',
      projected_profile_complete: true
    });
    expect(result.legs).toEqual([
      { candidate_id: 'c', order_id: 'c', asset_key: 'both', quantity: '1' }
    ]);
  });

  it('includes shared execution overhead once when choosing the lowest total route', () => {
    const result = planCollectingAcquisitions(
      analysis([{ assets: ['a'] }, { assets: ['b'] }]),
      [
        candidate('a1', 'a', '1', { group_cost_wei: '4' }),
        candidate('b1', 'b', '1', { group_cost_wei: '4' }),
        candidate('a2', 'a', '2', {
          execution_group: 'shared',
          group_cost_wei: '3'
        }),
        candidate('b2', 'b', '2', {
          execution_group: 'shared',
          group_cost_wei: '3'
        })
      ],
      options
    );
    expect(result.total_cost_wei).toBe('7');
    expect(result.legs.map((leg) => leg.order_id)).toEqual(['a2', 'b2']);
  });

  it('does not treat overlapping orders against the same inventory as independent supply', () => {
    const result = planCollectingAcquisitions(
      analysis([{ assets: ['card'], missing: '2' }]),
      [
        candidate('a', 'card', '1', { inventory_key: 'maker-card' }),
        candidate('b', 'card', '2', { inventory_key: 'maker-card' })
      ],
      options
    );
    expect(result).toMatchObject({
      status: 'partial',
      total_cost_wei: '1',
      projected_profile_complete: false,
      remaining_requirements: [{ requirement_id: '0', missing_quantity: '1' }]
    });
  });

  it('respects edition quantity, expiry and total budget without counting external delivery as profile progress', () => {
    const result = planCollectingAcquisitions(
      analysis([{ assets: ['card'], missing: '3' }], false),
      [
        candidate('live', 'card', '2', {
          quantity_available: '5',
          inventory_quantity: '5'
        }),
        candidate('expired', 'card', '0', {
          valid_until: options.evaluated_at,
          quantity_available: '5',
          inventory_quantity: '5'
        })
      ],
      { ...options, budget_wei: '4' }
    );
    expect(result).toMatchObject({
      status: 'partial',
      total_cost_wei: '4',
      projected_profile_complete: false,
      projected_profile_satisfied_count: 0
    });
    expect(result.legs[0].quantity).toBe('2');
  });

  it('keeps large wei amounts exact and labels a bounded search honestly', () => {
    const result = planCollectingAcquisitions(
      analysis([{ assets: ['card'], missing: '3' }]),
      [
        candidate('a', 'card', '9007199254740993', {
          quantity_available: '3',
          inventory_quantity: '3'
        })
      ],
      { ...options, max_states: 1 }
    );
    expect(result.total_cost_wei).toBe('27021597764222979');
    expect(result.optimality).toBe('best_found');
  });

  it('rejects inconsistent source groups and duplicate order publication from different providers', () => {
    expect(() =>
      planCollectingAcquisitions(
        analysis([{ assets: ['card'] }]),
        [
          candidate('a', 'card', '1', { execution_group: 'group' }),
          candidate('b', 'card', '2', {
            execution_group: 'group',
            group_cost_wei: '1'
          })
        ],
        options
      )
    ).toThrow('Inconsistent');
    expect(() =>
      planCollectingAcquisitions(
        analysis([{ assets: ['card'] }]),
        [
          candidate('a', 'card', '1'),
          candidate('b', 'card', '1', { order_id: 'a' })
        ],
        options
      )
    ).toThrow('Repeated');
  });
});
