import type { ConsolidatedTDH, TokenTDH } from '@/entities/ITDH';
import { calculateConsolidationChangePlan } from './tdh-history-consolidation-changes';

function token(id: number, tdh: number, rawTdh: number, balance = 1): TokenTDH {
  return {
    id,
    tdh,
    tdh__raw: rawTdh,
    balance,
    hodl_rate: 1,
    days_held_per_edition: []
  };
}

function consolidation(
  key: string,
  tokens: TokenTDH[],
  wallets = key.split('-'),
  boost = 1
): ConsolidatedTDH {
  const tdh = tokens.reduce((sum, entry) => sum + entry.tdh, 0);
  const rawTdh = tokens.reduce((sum, entry) => sum + entry.tdh__raw, 0);
  const balance = tokens.reduce((sum, entry) => sum + entry.balance, 0);
  return {
    consolidation_key: key,
    consolidation_display: key,
    wallets,
    boost,
    tdh,
    boosted_tdh: tokens.reduce(
      (sum, entry) => sum + Math.round(entry.tdh * boost),
      0
    ),
    tdh__raw: rawTdh,
    balance,
    memes: tokens,
    gradients: [],
    nextgen: []
  } as unknown as ConsolidatedTDH;
}

function totalChanges(
  plan: ReturnType<typeof calculateConsolidationChangePlan>
) {
  return [
    ...plan.allocations.map(({ changes }) => changes),
    ...plan.lost.map(({ changes }) => changes)
  ].reduce(
    (total, changes) => ({
      created: total.created + changes.tdhCreated,
      destroyed: total.destroyed + changes.tdhDestroyed,
      boostedCreated: total.boostedCreated + changes.boostedTdhCreated,
      boostedDestroyed: total.boostedDestroyed + changes.boostedTdhDestroyed
    }),
    { created: 0, destroyed: 0, boostedCreated: 0, boostedDestroyed: 0 }
  );
}

describe('calculateConsolidationChangePlan', () => {
  it('counts a split parent snapshot exactly once across its children', () => {
    const previous = [
      consolidation('0xa-0xb', [token(1, 300, 30, 2)], undefined, 1.5)
    ];
    const current = [
      consolidation('0xa', [token(1, 110, 11)], undefined, 1.5),
      consolidation('0xb', [token(1, 210, 21)], undefined, 1.5)
    ];

    const plan = calculateConsolidationChangePlan(current, previous);

    expect(plan.lost).toEqual([]);
    expect(totalChanges(plan)).toEqual({
      created: 20,
      destroyed: 0,
      boostedCreated: 30,
      boostedDestroyed: 0
    });
  });

  it('keeps gains and losses on the child holding the affected token', () => {
    const previous = [
      consolidation('0xa-0xb', [token(1, 100, 10), token(2, 200, 20)])
    ];
    const current = [
      consolidation('0xa', [token(1, 120, 12)]),
      consolidation('0xb', [token(2, 180, 18)])
    ];

    const plan = calculateConsolidationChangePlan(current, previous);

    expect(plan.allocations[0].changes.tdhCreated).toBe(20);
    expect(plan.allocations[0].changes.tdhDestroyed).toBe(0);
    expect(plan.allocations[1].changes.tdhCreated).toBe(0);
    expect(plan.allocations[1].changes.tdhDestroyed).toBe(20);
  });

  it('aggregates all parent snapshots when consolidations merge', () => {
    const previous = [
      consolidation('0xa', [token(1, 100, 10)]),
      consolidation('0xb', [token(2, 200, 20)])
    ];
    const current = [
      consolidation('0xa-0xb', [token(1, 110, 11), token(2, 210, 21)])
    ];

    const plan = calculateConsolidationChangePlan(current, previous);

    expect(plan.lost).toEqual([]);
    expect(plan.allocations[0].changes.tdhCreated).toBe(20);
    expect(plan.allocations[0].changes.tdhDestroyed).toBe(0);
  });

  it('records a token absent from every split child on the prior consolidation', () => {
    const previous = [
      consolidation('0xa-0xb', [token(1, 100, 10), token(2, 50, 5)])
    ];
    const current = [
      consolidation('0xa', [token(1, 50, 5)]),
      consolidation('0xb', [token(1, 50, 5)])
    ];

    const plan = calculateConsolidationChangePlan(current, previous);

    expect(plan.lost).toHaveLength(1);
    expect(plan.lost[0].previous).toBe(previous[0]);
    expect(plan.lost[0].changes.tdhDestroyed).toBe(50);
    expect(totalChanges(plan).created - totalChanges(plan).destroyed).toBe(-50);
  });

  it('prefers an exact key match over wallet-overlap fallback', () => {
    const exact = consolidation('0xa', [token(1, 100, 10)]);
    const overlappingOnlyByWallets = consolidation(
      '0xc',
      [token(2, 200, 20)],
      ['0xa', '0xc']
    );
    const current = consolidation('0xa', [token(1, 110, 11)]);

    const plan = calculateConsolidationChangePlan(
      [current],
      [exact, overlappingOnlyByWallets]
    );

    expect(plan.allocations[0].changes.tdhCreated).toBe(10);
    expect(plan.allocations[0].changes.tdhDestroyed).toBe(0);
    expect(plan.lost).toHaveLength(1);
    expect(plan.lost[0].previous).toBe(overlappingOnlyByWallets);
  });

  it('records a completely disappeared consolidation with negative net balance', () => {
    const previous = consolidation('0xa', [token(1, 100, 10)]);

    const plan = calculateConsolidationChangePlan([], [previous]);

    expect(plan.lost[0].changes).toEqual({
      tdhCreated: 0,
      tdhDestroyed: 100,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 100,
      rawTdhCreated: 0,
      rawTdhDestroyed: 10,
      balanceCreated: 0,
      balanceDestroyed: 1
    });
    expect(
      plan.lost[0].changes.balanceCreated -
        plan.lost[0].changes.balanceDestroyed
    ).toBe(-1);
  });
});
