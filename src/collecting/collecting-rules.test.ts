import * as fc from 'fast-check';
import { MEMES_CONTRACT, GRADIENT_CONTRACT } from '@/constants';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  assertCollectingRuleContinuation,
  createCollectingRule,
  currentRule,
  normalizeRuleDefinition,
  pauseCollectingRule,
  reserveCollectingRuleReview,
  settleCollectingRule
} from '@/collecting/collecting-rules';
import {
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from '@/collecting/collecting-rules.types';

const now = Date.parse('2026-09-01T12:00:00Z');
const funding = '0x0000000000000000000000000000000000000011';
const recipient = '0x0000000000000000000000000000000000000022';
const asset = collectingAssetKey(MEMES_CONTRACT, '1');

export function ruleDefinition(): CollectingRuleDefinition {
  return {
    profile_id: 'profile-1',
    funding_wallet: funding,
    recipient,
    plan_id: null,
    analysis_id: null,
    targets: [
      { asset_key: asset, target_quantity: '2', maximum_unit_price_wei: '100' }
    ],
    max_total_cost_wei: '250',
    max_gas_reserve_wei: '20',
    expires_at: now + 86400000,
    max_actions: 2
  };
}

function rule() {
  return createCollectingRule(
    'rule-1',
    normalizeRuleDefinition(ruleDefinition(), now),
    now
  );
}

export function ruleReview(operationId = 'operation-1'): CollectingRuleReview {
  return {
    operation_id: operationId,
    quote_id: 'quote-1',
    profile_id: 'profile-1',
    funding_wallet: funding,
    recipient,
    valid_until: now + 60000,
    assets: [{ asset_key: asset, quantity: '1', unit_price_wei: '100' }],
    item_cost_wei: '100',
    gas_reserve_wei: '20'
  };
}

export function ruleSettlement(
  operationId = 'operation-1'
): CollectingRuleSettlement {
  return {
    operation_id: operationId,
    status: 'confirmed',
    transaction_hash: `0x${'a'.repeat(64)}`,
    recipient,
    assets: [{ asset_key: asset, quantity: '1' }],
    item_cost_wei: '100',
    gas_cost_wei: '10'
  };
}

describe('saved collecting rules', () => {
  it('keeps refreshed quotes within the immutable pending review and blocks prompts after pause', () => {
    const pending = reserveCollectingRuleReview(rule(), ruleReview(), now);
    expect(() =>
      assertCollectingRuleContinuation(
        pending,
        { ...ruleReview(), gas_reserve_wei: '19', valid_until: now + 90000 },
        now + 1
      )
    ).not.toThrow();
    expect(() =>
      assertCollectingRuleContinuation(
        pending,
        { ...ruleReview(), gas_reserve_wei: '21' },
        now + 1
      )
    ).toThrow('gas exceeds');
    expect(() =>
      assertCollectingRuleContinuation(
        pending,
        { ...ruleReview(), item_cost_wei: '99' },
        now + 1
      )
    ).toThrow('item price');
    const paused = pauseCollectingRule(
      pending,
      true,
      pending.revision,
      now + 1
    );
    expect(() =>
      assertCollectingRuleContinuation(paused, ruleReview(), now + 2)
    ).toThrow('Pause or expiry');
    expect(() =>
      settleCollectingRule(paused, ruleSettlement(), now + 2)
    ).not.toThrow();
  });
  it('freezes exact canonical targets and supports external recipients', () => {
    const definition = normalizeRuleDefinition(ruleDefinition(), now);
    expect(definition.recipient).toBe(recipient);
    expect(createCollectingRule('rule', definition, now).mode).toBe(
      'prepare_for_approval'
    );
    expect(() =>
      normalizeRuleDefinition(
        {
          ...definition,
          targets: [...definition.targets, ...definition.targets]
        },
        now
      )
    ).toThrow('Duplicate');
    expect(() =>
      normalizeRuleDefinition(
        {
          ...definition,
          targets: [
            {
              ...definition.targets[0],
              asset_key: collectingAssetKey(GRADIENT_CONTRACT, '1')
            }
          ]
        },
        now
      )
    ).toThrow('quantity one');
    expect(() =>
      normalizeRuleDefinition({ ...definition, max_actions: 0 }, now)
    ).toThrow('action limit');
  });

  it('retains one pending operation across pause, resume, and expiration', () => {
    const pending = reserveCollectingRuleReview(rule(), ruleReview(), now);
    const paused = pauseCollectingRule(
      pending,
      true,
      pending.revision,
      now + 1
    );
    expect(paused.pending_review?.operation_id).toBe('operation-1');
    const resumed = pauseCollectingRule(
      paused,
      false,
      paused.revision,
      now + 2
    );
    expect(() =>
      reserveCollectingRuleReview(resumed, ruleReview('operation-2'), now + 3)
    ).toThrow('pending operation');
    expect(currentRule(resumed, now + 86400000)).toMatchObject({
      state: 'EXPIRED',
      pending_review: ruleReview()
    });
    expect(() =>
      pauseCollectingRule(resumed, false, resumed.revision, now + 86400000)
    ).toThrow('finished');
    expect(() => pauseCollectingRule(resumed, true, 1, now + 3)).toThrow(
      'changed'
    );
  });

  it('enforces unit, total, gas, allocation, profile, funding and recipient review limits', () => {
    const base = ruleReview();
    const failures: Partial<CollectingRuleReview>[] = [
      { profile_id: 'profile-2' },
      { funding_wallet: recipient },
      { recipient: funding },
      { valid_until: now },
      { valid_until: now + 86400001 },
      { gas_reserve_wei: '21' },
      { item_cost_wei: '99' },
      { assets: [{ ...base.assets[0], quantity: '3' }], item_cost_wei: '300' },
      {
        assets: [{ ...base.assets[0], unit_price_wei: '101' }],
        item_cost_wei: '101'
      }
    ];
    for (const failure of failures)
      expect(() =>
        reserveCollectingRuleReview(rule(), { ...base, ...failure }, now)
      ).toThrow();
    const lowBudget = {
      ...rule(),
      definition: { ...rule().definition, max_total_cost_wei: '119' }
    };
    expect(() => reserveCollectingRuleReview(lowBudget, base, now)).toThrow(
      'lifetime review budget'
    );
  });

  it('never resets acquired quantities based on later holdings or sales', () => {
    const once = settleCollectingRule(
      reserveCollectingRuleReview(rule(), ruleReview(), now),
      ruleSettlement(),
      now + 1
    );
    expect(once.acquired[0].quantity).toBe('1');
    const pending = reserveCollectingRuleReview(
      once,
      ruleReview('operation-2'),
      now + 2
    );
    const complete = settleCollectingRule(
      pending,
      ruleSettlement('operation-2'),
      now + 3
    );
    expect(complete).toMatchObject({
      state: 'COMPLETED',
      acquired: [{ asset_key: asset, quantity: '2' }],
      action_count: 2,
      spent_item_cost_wei: '200',
      spent_gas_cost_wei: '20'
    });
    expect(() =>
      reserveCollectingRuleReview(complete, ruleReview('operation-3'), now + 4)
    ).toThrow('not active');
    expect(() =>
      pauseCollectingRule(complete, false, complete.revision, now + 4)
    ).toThrow('finished');
  });

  it('records reverted gas and late receipts while preserving a user pause', () => {
    const pending = reserveCollectingRuleReview(rule(), ruleReview(), now);
    const paused = pauseCollectingRule(
      pending,
      true,
      pending.revision,
      now + 1
    );
    const result = settleCollectingRule(
      paused,
      {
        ...ruleSettlement(),
        status: 'reverted',
        assets: [],
        item_cost_wei: '0'
      },
      now + 2
    );
    expect(result).toMatchObject({
      state: 'PAUSED',
      pause_reason: 'USER_PAUSED',
      acquired: [{ asset_key: asset, quantity: '0' }],
      action_count: 1,
      spent_gas_cost_wei: '10',
      pending_review: null
    });
  });

  it('records actual gas over a review truthfully and pauses further preparation', () => {
    const result = settleCollectingRule(
      reserveCollectingRuleReview(rule(), ruleReview(), now),
      { ...ruleSettlement(), gas_cost_wei: '151' },
      now + 1
    );
    expect(result).toMatchObject({
      state: 'PAUSED',
      pause_reason: 'ACTUAL_COST_EXCEEDED_REVIEW',
      spent_gas_cost_wei: '151',
      acquired: [{ asset_key: asset, quantity: '1' }]
    });
    expect(() =>
      pauseCollectingRule(result, false, result.revision, now + 2)
    ).toThrow('review limits');
  });

  it('rejects mismatched or unproven receipts without clearing pending', () => {
    const pending = reserveCollectingRuleReview(rule(), ruleReview(), now);
    for (const difference of [
      { operation_id: 'wrong-operation' },
      { transaction_hash: null },
      { recipient: funding },
      { assets: [{ asset_key: asset, quantity: '3' }] },
      { status: 'expired' as const, transaction_hash: null }
    ])
      expect(() =>
        settleCollectingRule(
          pending,
          { ...ruleSettlement(), ...difference },
          now + 1
        )
      ).toThrow();
    expect(pending.pending_review).not.toBeNull();
  });

  it('releases only an explicit proof-backed unmined terminal outcome without spend credit', () => {
    const result = settleCollectingRule(
      reserveCollectingRuleReview(rule(), ruleReview(), now),
      {
        ...ruleSettlement(),
        status: 'cancelled',
        transaction_hash: null,
        assets: [],
        item_cost_wei: '0',
        gas_cost_wei: '0'
      },
      now + 1
    );
    expect(result).toMatchObject({
      state: 'ACTIVE',
      action_count: 0,
      review_count: 1,
      pending_review: null,
      spent_item_cost_wei: '0',
      spent_gas_cost_wei: '0'
    });
  });

  it('never reserves more than remaining quantities across a generated acquisition sequence', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (count) => {
        const definition = {
          ...ruleDefinition(),
          targets: [
            {
              ...ruleDefinition().targets[0],
              target_quantity: count.toString()
            }
          ],
          max_actions: count,
          max_total_cost_wei: (count * 120).toString()
        };
        let state = createCollectingRule(
          'rule',
          normalizeRuleDefinition(definition, now),
          now
        );
        for (let i = 0; i < count; i++) {
          const id = `operation-${i}`;
          state = settleCollectingRule(
            reserveCollectingRuleReview(state, ruleReview(id), now + i),
            ruleSettlement(id),
            now + i
          );
          expect(state.acquired[0].quantity).toBe((i + 1).toString());
        }
        expect(state.state).toBe('COMPLETED');
        expect(() =>
          reserveCollectingRuleReview(state, ruleReview('extra'), now + count)
        ).toThrow();
      }),
      { numRuns: 50 }
    );
  });
});
