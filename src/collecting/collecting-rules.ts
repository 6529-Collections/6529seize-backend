import { isAddress } from 'ethers';
import { MEMES_CONTRACT, GRADIENT_CONTRACT, NULL_ADDRESS } from '@/constants';
import { Network } from '@/alchemy-sdk';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import {
  CollectingRule,
  CollectingRuleDefinition,
  CollectingRuleReview,
  CollectingRuleSettlement
} from '@/collecting/collecting-rules.types';

const UINT256 = BigInt(
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);
const MAX_REVIEWS = 10000;

export function ruleConflict(message: string): never {
  throw new CustomApiCompliantException(409, message, 'COLLECT_RULE_CONFLICT');
}

function amount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) > UINT256)
    throw new BadRequestException('Invalid rule amount');
  return BigInt(value);
}

function quantity(value: string): bigint {
  if (!/^[1-9]\d{0,3}$/.test(value))
    throw new BadRequestException('Rule quantities must be between 1 and 9999');
  return BigInt(value);
}

function wallet(value: string): string {
  if (!isAddress(value) || value.toLowerCase() === NULL_ADDRESS)
    throw new BadRequestException('Invalid rule wallet');
  return value.toLowerCase();
}

function validId(value: string, maxLength: number): void {
  if (!value || value.length > maxLength || !/^[a-zA-Z0-9_-]+$/.test(value))
    throw new BadRequestException('Invalid rule identifier');
}

function validateAsset(assetKey: string, count: string): void {
  const [chain, contract, token, extra] = assetKey.split(':');
  const known = [
    MEMES_CONTRACT,
    GRADIENT_CONTRACT,
    NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET]
  ].map((value) => value.toLowerCase());
  if (
    chain !== '1' ||
    !contract ||
    token === undefined ||
    extra !== undefined ||
    !known.includes(contract) ||
    collectingAssetKey(contract, token) !== assetKey
  )
    throw new BadRequestException('Invalid collecting rule asset');
  if (
    quantity(count) !== BigInt(1) &&
    contract !== MEMES_CONTRACT.toLowerCase()
  )
    throw new BadRequestException('Unique NFTs require quantity one');
}

export function normalizeRuleDefinition(
  input: CollectingRuleDefinition,
  now: number
): CollectingRuleDefinition {
  validId(input.profile_id, 100);
  if (input.plan_id !== null) validId(input.plan_id, 36);
  if (input.analysis_id !== null) validId(input.analysis_id, 64);
  if (
    !Number.isSafeInteger(input.expires_at) ||
    input.expires_at <= now ||
    input.expires_at > now + 365 * 86400000
  )
    throw new BadRequestException(
      'Rule expiry must be within the next 365 days'
    );
  if (
    !Number.isInteger(input.max_actions) ||
    input.max_actions < 1 ||
    input.max_actions > 2000
  )
    throw new BadRequestException(
      'Rule action limit must be between 1 and 2000'
    );
  if (!input.targets.length || input.targets.length > 2000)
    throw new BadRequestException('Select between 1 and 2000 rule targets');
  if (
    amount(input.max_total_cost_wei) === BigInt(0) ||
    amount(input.max_gas_reserve_wei) > amount(input.max_total_cost_wei)
  )
    throw new BadRequestException('Invalid rule review budget');
  const seen = new Set<string>();
  const targets = input.targets
    .map((target) => {
      validateAsset(target.asset_key, target.target_quantity);
      amount(target.maximum_unit_price_wei);
      if (seen.has(target.asset_key))
        throw new BadRequestException('Duplicate rule target');
      seen.add(target.asset_key);
      return { ...target };
    })
    .sort((a, b) => a.asset_key.localeCompare(b.asset_key));
  return {
    profile_id: input.profile_id,
    funding_wallet: wallet(input.funding_wallet),
    recipient: wallet(input.recipient),
    plan_id: input.plan_id,
    analysis_id: input.analysis_id,
    targets,
    max_total_cost_wei: input.max_total_cost_wei,
    max_gas_reserve_wei: input.max_gas_reserve_wei,
    expires_at: input.expires_at,
    max_actions: input.max_actions
  };
}

export function createCollectingRule(
  id: string,
  definition: CollectingRuleDefinition,
  now: number
): CollectingRule {
  return {
    id,
    mode: 'prepare_for_approval',
    definition,
    revision: 1,
    state: 'ACTIVE',
    pause_reason: null,
    acquired: definition.targets.map((target) => ({
      asset_key: target.asset_key,
      quantity: '0'
    })),
    spent_item_cost_wei: '0',
    spent_gas_cost_wei: '0',
    action_count: 0,
    review_count: 0,
    pending_review: null,
    created_at: now,
    updated_at: now
  };
}

export function currentRule(rule: CollectingRule, now: number): CollectingRule {
  if (rule.state === 'COMPLETED') return rule;
  if (rule.definition.expires_at <= now) return { ...rule, state: 'EXPIRED' };
  return rule;
}

function changed(rule: CollectingRule, now: number): CollectingRule {
  return { ...rule, revision: rule.revision + 1, updated_at: now };
}

export function pauseCollectingRule(
  rule: CollectingRule,
  paused: boolean,
  expectedRevision: number,
  now: number
): CollectingRule {
  if (rule.revision !== expectedRevision)
    ruleConflict('Rule changed. Reload before updating it.');
  const current = currentRule(rule, now);
  if (current.state === 'COMPLETED' || current.state === 'EXPIRED')
    ruleConflict('This rule has finished.');
  if (
    !paused &&
    (rule.action_count >= rule.definition.max_actions ||
      rule.review_count >= MAX_REVIEWS ||
      amount(rule.spent_item_cost_wei) + amount(rule.spent_gas_cost_wei) >=
        amount(rule.definition.max_total_cost_wei))
  )
    ruleConflict('This rule has reached its review limits.');
  return changed(
    {
      ...rule,
      state: paused ? 'PAUSED' : 'ACTIVE',
      pause_reason: paused ? 'USER_PAUSED' : null
    },
    now
  );
}

function reviewAssets(
  rule: CollectingRule,
  review: CollectingRuleReview
): bigint {
  if (!review.assets.length || review.assets.length > 2000)
    throw new BadRequestException('Invalid rule review assets');
  const targets = new Map(
    rule.definition.targets.map((target) => [target.asset_key, target])
  );
  const acquired = new Map(
    rule.acquired.map((entry) => [entry.asset_key, BigInt(entry.quantity)])
  );
  const seen = new Set<string>();
  let total = BigInt(0);
  for (const asset of review.assets) {
    const target = targets.get(asset.asset_key);
    if (!target || seen.has(asset.asset_key))
      ruleConflict('Review contains an unexpected or repeated asset.');
    seen.add(asset.asset_key);
    const count = quantity(asset.quantity);
    if (
      count + (acquired.get(asset.asset_key) ?? BigInt(0)) >
      BigInt(target.target_quantity)
    )
      ruleConflict('Review would exceed the remaining rule target.');
    const price = amount(asset.unit_price_wei);
    if (price > amount(target.maximum_unit_price_wei))
      ruleConflict('Review exceeds the unit price limit.');
    total += count * price;
  }
  return total;
}

export function reserveCollectingRuleReview(
  rule: CollectingRule,
  review: CollectingRuleReview,
  now: number
): CollectingRule {
  if (currentRule(rule, now).state !== 'ACTIVE')
    ruleConflict('Rule is not active.');
  if (rule.pending_review)
    ruleConflict(
      'Resolve the pending operation before preparing another review.'
    );
  if (
    rule.action_count >= rule.definition.max_actions ||
    rule.review_count >= MAX_REVIEWS
  )
    ruleConflict('Rule action or review limit reached.');
  validId(review.operation_id, 36);
  validId(review.quote_id, 100);
  if (
    review.profile_id !== rule.definition.profile_id ||
    wallet(review.funding_wallet) !== rule.definition.funding_wallet ||
    wallet(review.recipient) !== rule.definition.recipient
  )
    ruleConflict(
      'Review does not match the saved profile, funding wallet and recipient.'
    );
  if (
    !Number.isSafeInteger(review.valid_until) ||
    review.valid_until <= now ||
    review.valid_until > rule.definition.expires_at
  )
    ruleConflict('Review is expired or outlives the saved rule.');
  const itemCost = reviewAssets(rule, review);
  const reserve = amount(review.gas_reserve_wei);
  if (amount(review.item_cost_wei) !== itemCost)
    ruleConflict('Review item costs do not match its assets.');
  if (reserve > amount(rule.definition.max_gas_reserve_wei))
    ruleConflict('Review exceeds the gas reserve limit.');
  const spent =
    amount(rule.spent_item_cost_wei) + amount(rule.spent_gas_cost_wei);
  if (spent + itemCost + reserve > amount(rule.definition.max_total_cost_wei))
    ruleConflict('Review exceeds the remaining lifetime review budget.');
  return changed(
    { ...rule, pending_review: review, review_count: rule.review_count + 1 },
    now
  );
}

/** Refreshing a quote cannot enlarge the review the user saved or bypass a pause. */
export function assertCollectingRuleContinuation(
  rule: CollectingRule,
  review: CollectingRuleReview,
  now: number
): void {
  const pending = rule.pending_review;
  if (currentRule(rule, now).state !== 'ACTIVE')
    ruleConflict(
      'Pause or expiry prevents another wallet prompt for this rule.'
    );
  if (!pending || pending.operation_id !== review.operation_id)
    ruleConflict('Operation is not the pending review for this rule.');
  if (
    review.profile_id !== pending.profile_id ||
    wallet(review.funding_wallet) !== wallet(pending.funding_wallet) ||
    wallet(review.recipient) !== wallet(pending.recipient)
  )
    ruleConflict(
      'Refreshed review changed the saved profile, funding wallet or recipient.'
    );
  if (
    !Number.isSafeInteger(review.valid_until) ||
    review.valid_until <= now ||
    review.valid_until > rule.definition.expires_at
  )
    ruleConflict('Refreshed review is expired or outlives the saved rule.');
  const assets = (value: CollectingRuleReview) =>
    value.assets
      .map((asset) => ({
        asset_key: asset.asset_key,
        quantity: asset.quantity,
        unit_price_wei: asset.unit_price_wei
      }))
      .sort((a, b) => a.asset_key.localeCompare(b.asset_key));
  if (
    JSON.stringify(assets(review)) !== JSON.stringify(assets(pending)) ||
    review.item_cost_wei !== pending.item_cost_wei
  )
    ruleConflict(
      'Refreshed review changed the reserved artwork, quantity or item price.'
    );
  if (amount(review.gas_reserve_wei) > amount(pending.gas_reserve_wei))
    ruleConflict('Refreshed gas exceeds the pending review reserve.');
}

function verifiedSettlementAssets(
  review: CollectingRuleReview,
  settlement: CollectingRuleSettlement
): Map<string, bigint> {
  if (wallet(settlement.recipient) !== wallet(review.recipient))
    ruleConflict('Settlement recipient does not match the pending review.');
  const expected = new Map(
    review.assets.map((asset) => [asset.asset_key, BigInt(asset.quantity)])
  );
  const result = new Map<string, bigint>();
  for (const asset of settlement.assets) {
    if (!expected.has(asset.asset_key) || result.has(asset.asset_key))
      ruleConflict('Settlement contains unexpected or repeated assets.');
    const count = quantity(asset.quantity);
    if (count > expected.get(asset.asset_key)!)
      ruleConflict('Settlement exceeds the reviewed quantity.');
    result.set(asset.asset_key, count);
  }
  return result;
}

export function settleCollectingRule(
  rule: CollectingRule,
  settlement: CollectingRuleSettlement,
  now: number
): CollectingRule {
  const review = rule.pending_review;
  if (!review || settlement.operation_id !== review.operation_id)
    ruleConflict('Settlement does not match the pending operation.');
  const mined =
    settlement.status === 'confirmed' || settlement.status === 'reverted';
  const confirmed = settlement.status === 'confirmed';
  if (
    mined
      ? !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction_hash ?? '')
      : settlement.transaction_hash !== null
  )
    throw new BadRequestException(
      'Settlement requires a verified terminal transaction status'
    );
  const itemCost = amount(settlement.item_cost_wei);
  const gasCost = amount(settlement.gas_cost_wei);
  if (
    (!confirmed && (itemCost !== BigInt(0) || settlement.assets.length > 0)) ||
    (!mined && gasCost !== BigInt(0))
  )
    throw new BadRequestException(
      'Unmined or unsuccessful operations cannot report acquired assets or purchase costs'
    );
  const received = verifiedSettlementAssets(review, settlement);
  const acquired = rule.acquired.map((entry) => ({
    asset_key: entry.asset_key,
    quantity: (
      BigInt(entry.quantity) + (received.get(entry.asset_key) ?? BigInt(0))
    ).toString()
  }));
  const next = changed(
    {
      ...rule,
      acquired,
      pending_review: null,
      spent_item_cost_wei: (
        amount(rule.spent_item_cost_wei) + itemCost
      ).toString(),
      spent_gas_cost_wei: (
        amount(rule.spent_gas_cost_wei) + gasCost
      ).toString(),
      action_count: rule.action_count + (mined ? 1 : 0)
    },
    now
  );
  const complete = acquired.every(
    (entry, index) =>
      BigInt(entry.quantity) >=
      BigInt(rule.definition.targets[index].target_quantity)
  );
  const overReview =
    itemCost > amount(review.item_cost_wei) ||
    gasCost > amount(review.gas_reserve_wei);
  const limitReached =
    next.action_count >= rule.definition.max_actions ||
    next.review_count >= MAX_REVIEWS ||
    amount(next.spent_item_cost_wei) + amount(next.spent_gas_cost_wei) >=
      amount(rule.definition.max_total_cost_wei);
  if (overReview || limitReached) {
    next.state = 'PAUSED';
    next.pause_reason = overReview
      ? 'ACTUAL_COST_EXCEEDED_REVIEW'
      : 'REVIEW_LIMIT_REACHED';
  }
  if (complete) next.state = 'COMPLETED';
  return currentRule(next, now);
}
