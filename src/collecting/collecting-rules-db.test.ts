import 'reflect-metadata';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { CollectingRulesService } from '@/collecting/collecting-rules.service';
import {
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from '@/collecting/collecting-rules.types';
import { MEMES_CONTRACT } from '@/constants';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const now = Date.parse('2026-09-01T12:00:00Z');
const wallet = '0x0000000000000000000000000000000000000011';
const recipient = '0x0000000000000000000000000000000000000022';
const assetKey = collectingAssetKey(MEMES_CONTRACT, '1');
const definition: CollectingRuleDefinition = {
  profile_id: 'profile-1',
  funding_wallet: wallet,
  recipient,
  plan_id: null,
  analysis_id: null,
  targets: [
    { asset_key: assetKey, target_quantity: '2', maximum_unit_price_wei: '100' }
  ],
  max_total_cost_wei: '250',
  max_gas_reserve_wei: '20',
  expires_at: now + 86400000,
  max_actions: 2
};
function review(id: string): CollectingRuleReview {
  return {
    operation_id: id,
    quote_id: 'quote',
    profile_id: 'profile-1',
    funding_wallet: wallet,
    recipient,
    valid_until: now + 60000,
    assets: [{ asset_key: assetKey, quantity: '1', unit_price_wei: '100' }],
    item_cost_wei: '100',
    gas_reserve_wei: '20'
  };
}
function receipt(id: string): CollectingRuleSettlement {
  return {
    operation_id: id,
    status: 'confirmed',
    transaction_hash: `0x${'a'.repeat(64)}`,
    recipient,
    assets: [{ asset_key: assetKey, quantity: '1' }],
    item_cost_wei: '100',
    gas_cost_wei: '10'
  };
}

describeWithSeed('persistent collecting rules', [], () => {
  const service = new CollectingRulesService(dbSupplier, () => now);

  it('shares the enclosing market transaction and rolls back the rule binding with it', async () => {
    const rule = await service.create(definition, 'request-1');
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await service.reserveReview(
          rule.id,
          'profile-1',
          review('operation-1'),
          connection
        );
        throw new Error('market-transition-rejected');
      })
    ).rejects.toThrow('market-transition-rejected');
    expect(await service.get(rule.id, 'profile-1')).toMatchObject({
      revision: 1,
      review_count: 0,
      pending_review: null
    });
    expect(
      await sqlExecutor.execute('SELECT * FROM collect_rule_operations')
    ).toEqual([]);
    await service.reserveReview(rule.id, 'profile-1', review('operation-1'));
    const { operation_id, ...fresh } = review('operation-1');
    await expect(
      service.assertOperationContinuation(operation_id, {
        ...fresh,
        gas_reserve_wei: '21'
      })
    ).rejects.toThrow('gas exceeds');
    await expect(
      service.assertOperationContinuation(operation_id, fresh)
    ).resolves.toBeUndefined();
    const saved = await service.get(rule.id, 'profile-1');
    await service.setPaused(rule.id, 'profile-1', saved.revision, true);
    await expect(
      service.assertOperationContinuation(operation_id, fresh)
    ).rejects.toThrow('Pause or expiry');
  });

  it('creates idempotently, persists decimal amounts, and scopes reads by profile', async () => {
    const first = await service.create(definition, 'request-1');
    const repeat = await service.create(definition, 'request-1');
    expect(repeat).toEqual(first);
    expect(await service.get(first.id, 'profile-1')).toEqual(first);
    await expect(service.get(first.id, 'profile-2')).rejects.toThrow(
      'not found'
    );
    expect(await service.list('profile-2')).toEqual([]);
    await expect(
      service.create({ ...definition, max_total_cost_wei: '251' }, 'request-1')
    ).rejects.toThrow('different rule terms');
    expect((await service.list('profile-1')).length).toBe(1);
  });

  it('serializes competing reviews so exactly one operation reserves the rule', async () => {
    const rule = await service.create(definition, 'request-1');
    const attempts = await Promise.allSettled([
      service.reserveReview(rule.id, 'profile-1', review('operation-1')),
      service.reserveReview(rule.id, 'profile-1', review('operation-2'))
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    const saved = await service.get(rule.id, 'profile-1');
    expect(saved.review_count).toBe(1);
    const id = saved.pending_review!.operation_id;
    expect(
      await service.reserveReview(rule.id, 'profile-1', review(id))
    ).toEqual(saved);
    const bindings = await sqlExecutor.execute<{ operation_id: string }>(
      'SELECT operation_id FROM collect_rule_operations WHERE rule_id=:id',
      { id: rule.id }
    );
    expect(bindings).toEqual([{ operation_id: id }]);
  });

  it('credits receipts once and permanently prevents an operation being credited by another rule', async () => {
    const rule = await service.create(definition, 'request-1');
    await service.reserveReview(rule.id, 'profile-1', review('operation-1'));
    const settled = await service.settle(
      rule.id,
      'profile-1',
      receipt('operation-1')
    );
    expect(settled).toMatchObject({
      acquired: [{ asset_key: assetKey, quantity: '1' }],
      action_count: 1,
      spent_item_cost_wei: '100',
      spent_gas_cost_wei: '10',
      pending_review: null
    });
    expect(
      await service.settle(rule.id, 'profile-1', receipt('operation-1'))
    ).toEqual(settled);
    await expect(
      service.settle(rule.id, 'profile-1', {
        ...receipt('operation-1'),
        gas_cost_wei: '11'
      })
    ).rejects.toThrow('different evidence');
    const other = await service.create(definition, 'request-2');
    await expect(
      service.reserveReview(other.id, 'profile-1', review('operation-1'))
    ).rejects.toThrow('already bound');
    expect(
      (await service.get(other.id, 'profile-1')).pending_review
    ).toBeNull();
  });

  it('keeps pending recovery durable across pause, stale updates and expiration', async () => {
    const rule = await service.create(definition, 'request-1');
    const pending = await service.reserveReview(
      rule.id,
      'profile-1',
      review('operation-1')
    );
    const paused = await service.setPaused(
      rule.id,
      'profile-1',
      pending.revision,
      true
    );
    expect(paused.pending_review?.operation_id).toBe('operation-1');
    await expect(
      service.setPaused(rule.id, 'profile-1', pending.revision, false)
    ).rejects.toThrow('changed');
    const later = new CollectingRulesService(
      dbSupplier,
      () => definition.expires_at + 1
    );
    expect(await later.get(rule.id, 'profile-1')).toMatchObject({
      state: 'EXPIRED',
      pending_review: review('operation-1')
    });
    await expect(
      later.reserveReview(rule.id, 'profile-1', review('operation-2'))
    ).rejects.toThrow('not active');
    const recovered = await later.settle(
      rule.id,
      'profile-1',
      receipt('operation-1')
    );
    expect(recovered).toMatchObject({
      state: 'EXPIRED',
      pending_review: null,
      acquired: [{ asset_key: assetKey, quantity: '1' }]
    });
  });
});
