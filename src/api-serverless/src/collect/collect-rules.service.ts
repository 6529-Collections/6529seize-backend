import { AuthenticationContext } from '@/auth-context';
import {
  assertMarketActor,
  prepareMarketOperation,
  readMarketOperation
} from '@/api/marketplace/marketplace.service';
import { collectingService } from '@/collecting/collecting.service';
import { collectingDb } from '@/collecting/collecting.db';
import { collectingRulesService } from '@/collecting/collecting-rules.service';
import {
  CollectingRuleDefinition,
  CollectingRuleReview
} from '@/collecting/collecting-rules.types';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { MarketPrepareRequest } from '@/marketplace/market-preparation';
import { MARKET_ZERO_ADDRESS } from '@/marketplace/seaport.registry';
import {
  marketOperationsDb,
  marketRequestHash
} from '@/marketplace/market-operations.db';
import { marketChain } from '@/marketplace/market-chain';
import { readCollectPlan } from './collect-plans.service';

type Actor = ReturnType<typeof assertMarketActor>;
export async function requireRuleWallet(id: string, actor: Actor) {
  const rule = await collectingRulesService.get(id, actor.profileId);
  if (
    rule.definition.funding_wallet.toLowerCase() !== actor.wallet.toLowerCase()
  )
    throw new ForbiddenException('Switch to the funding wallet for this rule.');
  return rule;
}

export async function createRule(
  auth: AuthenticationContext,
  definition: CollectingRuleDefinition,
  key: string
) {
  const actor = assertMarketActor(auth);
  if (
    actor.profileId !== definition.profile_id ||
    actor.wallet.toLowerCase() !== definition.funding_wallet.toLowerCase()
  )
    throw new ForbiddenException(
      'Create a rule for your active profile and signing wallet.'
    );
  const scope = await collectingDb.readAccountHoldings(actor.profileId);
  if (
    !scope.account.wallets.some(
      (wallet) => wallet.toLowerCase() === actor.wallet.toLowerCase()
    )
  )
    throw new ForbiddenException('The funding wallet is not in this profile.');
  const catalog = await collectingService.getCatalog();
  const keys = new Set(catalog.assets.map((asset) => asset.asset_key));
  if (definition.targets.some((target) => !keys.has(target.asset_key)))
    throw new BadRequestException(
      'Choose exact artworks from the current collection catalog.'
    );
  if (definition.plan_id) {
    const plan = await readCollectPlan(definition.plan_id, actor.profileId);
    if (definition.analysis_id !== plan.analysis.analysis_id)
      throw new BadRequestException(
        'The saved plan and analysis do not match.'
      );
  } else if (definition.analysis_id !== null)
    throw new BadRequestException(
      'An analysis reference requires its saved plan.'
    );
  return collectingRulesService.create(definition, key);
}

export async function prepareRule(
  id: string,
  auth: AuthenticationContext,
  input: { expected_revision: number; trade: MarketPrepareRequest },
  key: string
) {
  const actor = assertMarketActor(auth, input.trade),
    rule = await requireRuleWallet(id, actor),
    trade = input.trade;
  if (
    trade.kind !== 'BUY' ||
    trade.currency.toLowerCase() !== MARKET_ZERO_ADDRESS
  )
    throw new BadRequestException('Rules prepare exact ETH purchases only.');
  if (rule.pending_review) {
    const pending = await marketOperationsDb.get(
      rule.pending_review.operation_id,
      actor.profileId
    );
    if (
      pending.idempotency_key === key &&
      pending.request_hash === marketRequestHash(trade)
    )
      return { rule, operation: await readMarketOperation(pending.id, auth) };
    throw new CustomApiCompliantException(
      409,
      'Recover the outstanding purchase before preparing another.',
      'RULE_PENDING'
    );
  }
  if (rule.revision !== input.expected_revision)
    throw new CustomApiCompliantException(
      409,
      'The rule changed. Refresh its remaining limits.',
      'RULE_CHANGED'
    );
  if (trade.recipient.toLowerCase() !== rule.definition.recipient.toLowerCase())
    throw new ForbiddenException('This recipient differs from the saved rule.');
  const target = rule.definition.targets.find(
    (item) => item.asset_key === trade.asset_key
  );
  if (
    !target ||
    BigInt(trade.quantity) === BigInt(0) ||
    BigInt(trade.amount_wei) >
      BigInt(target.maximum_unit_price_wei) * BigInt(trade.quantity)
  )
    throw new BadRequestException(
      'The purchase is outside this rule’s exact artwork or price limits.'
    );
  if (BigInt(trade.amount_wei) % BigInt(trade.quantity) !== BigInt(0))
    throw new BadRequestException(
      'This quantity does not have an exact whole-wei unit price. Choose another quantity for the rule.'
    );
  const operation = await prepareMarketOperation(auth, trade, key, {
    ruleId: id,
    beforeExpose: async (operationId, prepared, connection) => {
      if (
        !prepared?.gas ||
        !prepared.transaction ||
        prepared.approvalTransactions.length
      )
        throw new CustomApiCompliantException(
          409,
          'This purchase is not ready for a rule review.'
        );
      const review: CollectingRuleReview = {
        operation_id: operationId,
        quote_id: marketRequestHash(prepared),
        profile_id: actor.profileId,
        funding_wallet: actor.wallet,
        recipient: prepared.intent.recipient,
        valid_until: Math.min(Date.now() + 20000, rule.definition.expires_at),
        assets: [
          {
            asset_key: trade.asset_key,
            quantity: prepared.intent.quantity,
            unit_price_wei: (
              BigInt(prepared.intent.maxTotalWei) /
              BigInt(prepared.intent.quantity)
            ).toString()
          }
        ],
        item_cost_wei: prepared.intent.maxTotalWei,
        gas_reserve_wei: prepared.gas.gas_reserve_wei
      };
      await collectingRulesService.reserveReview(
        id,
        actor.profileId,
        review,
        connection
      );
    }
  });
  const reserved = await collectingRulesService.get(id, actor.profileId);
  return { rule: reserved, operation };
}

export async function reconcileRule(id: string, auth: AuthenticationContext) {
  const actor = assertMarketActor(auth),
    rule = await requireRuleWallet(id, actor),
    pending = rule.pending_review;
  if (!pending) return rule;
  const operation = await readMarketOperation(pending.operation_id, auth);
  if (
    !['CONFIRMED', 'FAILED'].includes(operation.state) ||
    !operation.transaction_hash
  )
    return rule;
  const [receipt, safe] = await Promise.all([
    marketChain().rpc.getTransactionReceipt(operation.transaction_hash),
    marketChain().rpc.getBlock('safe')
  ]);
  if (!receipt || !safe || safe.number < receipt.blockNumber) return rule;
  const canonical = await marketChain().rpc.getBlock(receipt.blockNumber);
  if (canonical?.hash !== receipt.blockHash)
    throw new CustomApiCompliantException(
      409,
      'The receipt changed. Keep this purchase pending and reconcile again.',
      'RECEIPT_REORG'
    );
  const confirmed = operation.state === 'CONFIRMED';
  if (confirmed && !operation.settlement) return rule;
  if (
    (confirmed && receipt.status !== 1) ||
    (!confirmed && receipt.status !== 0)
  )
    return rule;
  return collectingRulesService.settle(id, actor.profileId, {
    operation_id: operation.id,
    status: confirmed ? 'confirmed' : 'reverted',
    transaction_hash: operation.transaction_hash,
    recipient: operation.recipient,
    assets: confirmed
      ? [
          {
            asset_key: operation.asset_key,
            quantity: operation.settlement!.filled_quantity
          }
        ]
      : [],
    item_cost_wei: confirmed ? operation.total_wei : '0',
    gas_cost_wei: (receipt.gasUsed * receipt.gasPrice).toString()
  });
}
