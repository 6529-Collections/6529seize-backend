import type { ConsolidatedTDH, TokenTDH } from '@/entities/ITDH';
import {
  calculateConsolidationChangePlan,
  calculateLostConsolidationChanges
} from './tdh-history-consolidation-changes';

function token(
  id: number,
  tdh: number,
  rawTdh: number,
  balance: number
): TokenTDH {
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
  boost = 1
): ConsolidatedTDH {
  const tdh = tokens.reduce((sum, entry) => sum + entry.tdh, 0);
  const rawTdh = tokens.reduce((sum, entry) => sum + entry.tdh__raw, 0);
  const balance = tokens.reduce((sum, entry) => sum + entry.balance, 0);
  return {
    consolidation_key: key,
    consolidation_display: key,
    wallets: key.split('-'),
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

describe('calculateConsolidationChangePlan', () => {
  it('calculates a split once instead of replaying the parent into each child', () => {
    const previous = [consolidation('0xa-0xb', [token(1, 300, 30, 2)], 1.5)];
    const current = [
      consolidation('0xa', [token(1, 110, 11, 1)], 1.5),
      consolidation('0xb', [token(1, 210, 21, 1)], 1.5)
    ];

    const plan = calculateConsolidationChangePlan(current, previous);
    const total = plan.allocations.reduce(
      (sum, allocation) => ({
        tdhCreated: sum.tdhCreated + allocation.changes.tdhCreated,
        tdhDestroyed: sum.tdhDestroyed + allocation.changes.tdhDestroyed,
        boostedCreated:
          sum.boostedCreated + allocation.changes.boostedTdhCreated,
        boostedDestroyed:
          sum.boostedDestroyed + allocation.changes.boostedTdhDestroyed,
        rawCreated: sum.rawCreated + allocation.changes.rawTdhCreated,
        rawDestroyed: sum.rawDestroyed + allocation.changes.rawTdhDestroyed,
        balanceCreated: sum.balanceCreated + allocation.changes.balanceCreated,
        balanceDestroyed:
          sum.balanceDestroyed + allocation.changes.balanceDestroyed
      }),
      {
        tdhCreated: 0,
        tdhDestroyed: 0,
        boostedCreated: 0,
        boostedDestroyed: 0,
        rawCreated: 0,
        rawDestroyed: 0,
        balanceCreated: 0,
        balanceDestroyed: 0
      }
    );

    expect(plan.lost).toEqual([]);
    expect(plan.allocations.map(({ changes }) => changes)).toEqual([
      {
        tdhCreated: 7,
        tdhDestroyed: 0,
        boostedTdhCreated: 10,
        boostedTdhDestroyed: 0,
        rawTdhCreated: 1,
        rawTdhDestroyed: 0,
        balanceCreated: 0,
        balanceDestroyed: 0
      },
      {
        tdhCreated: 13,
        tdhDestroyed: 0,
        boostedTdhCreated: 20,
        boostedTdhDestroyed: 0,
        rawTdhCreated: 1,
        rawTdhDestroyed: 0,
        balanceCreated: 0,
        balanceDestroyed: 0
      }
    ]);
    expect(total).toEqual({
      tdhCreated: 20,
      tdhDestroyed: 0,
      boostedCreated: 30,
      boostedDestroyed: 0,
      rawCreated: 2,
      rawDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('aggregates both parent snapshots when consolidations merge', () => {
    const previous = [
      consolidation('0xa', [token(1, 100, 10, 1)], 1.5),
      consolidation('0xb', [token(1, 200, 20, 1)], 1.5)
    ];
    const current = [consolidation('0xa-0xb', [token(1, 320, 32, 2)], 1.5)];

    const plan = calculateConsolidationChangePlan(current, previous);

    expect(plan.lost).toEqual([]);
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0].changes).toEqual({
      tdhCreated: 20,
      tdhDestroyed: 0,
      boostedTdhCreated: 30,
      boostedTdhDestroyed: 0,
      rawTdhCreated: 2,
      rawTdhDestroyed: 0,
      balanceCreated: 0,
      balanceDestroyed: 0
    });
  });

  it('keeps a completely disappeared consolidation as a lost entry', () => {
    const previous = consolidation('0xa', [token(1, 100, 10, 1)], 1.5);

    const plan = calculateConsolidationChangePlan([], [previous]);
    const changes = calculateLostConsolidationChanges(plan.lost[0]);

    expect(plan.allocations).toEqual([]);
    expect(changes).toEqual({
      tdhCreated: 0,
      tdhDestroyed: 100,
      boostedTdhCreated: 0,
      boostedTdhDestroyed: 150,
      rawTdhCreated: 0,
      rawTdhDestroyed: 10,
      balanceCreated: 0,
      balanceDestroyed: 1
    });
    expect(changes.balanceCreated - changes.balanceDestroyed).toBe(-1);
  });
});
