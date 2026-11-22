import type { TransactionReceipt } from 'ethers';
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
import {
  itemCost,
  SentEvidence,
  settlementFromReceipt,
  settlementProblem,
  usedNonceOutcome
} from '@/collecting/collecting-rules.chain-check';
import { nonceTransactionOnChain } from '@/collecting/collecting-rules.nonce-search';
import { personalRecordsMode } from '@/personal-records/personal-records.mode';
import { NotFoundException } from '@/exceptions';
import { readCollectPlan } from './collect-plans.service';

type Actor = ReturnType<typeof assertMarketActor>;
async function readRuleOperation(id: string, auth: AuthenticationContext) {
  const operation = await readMarketOperation(id, auth);
  if (operation.kind === 'BUY_BATCH')
    throw new ForbiddenException(
      'Atomic selections cannot execute a saved rule.'
    );
  return operation;
}
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
  await checkNewRuleTerms(actor.profileId, definition);
  return collectingRulesService.create(definition, key);
}

/**
 * Today's checks of a new rule's terms, for the route and for a person's
 * `collect.rule` record: the funding wallet is one of the profile's, the
 * artworks are in the current catalog, and a plan matches its analysis.
 */
export async function checkNewRuleTerms(
  profileId: string,
  definition: CollectingRuleDefinition
): Promise<void> {
  if (definition.profile_id !== profileId)
    throw new ForbiddenException('Create a rule for your own profile.');
  const scope = await collectingDb.readAccountHoldings(profileId);
  if (
    !scope.account.wallets.some(
      (wallet) =>
        wallet.toLowerCase() === definition.funding_wallet.toLowerCase()
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
    const plan = await readCollectPlan(definition.plan_id, profileId);
    if (definition.analysis_id !== plan.analysis.analysis_id)
      throw new BadRequestException(
        'The saved plan and analysis do not match.'
      );
  } else if (definition.analysis_id !== null)
    throw new BadRequestException(
      'An analysis reference requires its saved plan.'
    );
}

const outstandingPurchase = (message?: string) =>
  new CustomApiCompliantException(
    409,
    message ?? 'Recover the outstanding purchase before preparing another.',
    'RULE_PENDING'
  );

/**
 * Why a rule whose pending purchase's market operation is gone can't
 * prepare another: reconcile first, and for a purchase sent and not mined,
 * which nonce has to be used before it can be released.
 */
async function pendingPurchaseOf(operationId: string) {
  const binding = await collectingRulesService.findOperation(operationId);
  const nonce = binding?.transaction_nonce ?? null;
  return outstandingPurchase(
    binding?.transaction_hash && nonce !== null
      ? `The rule's last purchase was sent at nonce ${nonce} and isn't mined. Reconcile it; if it was dropped, send a replacement at nonce ${nonce} from the funding wallet, then reconcile.`
      : undefined
  );
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
    const operationId = rule.pending_review.operation_id;
    const pending = await marketOperationsDb
      .get(operationId, actor.profileId)
      .catch(async (error: unknown) => {
        // After a rebuild the market journal is gone: reconcile first.
        if (
          error instanceof NotFoundException &&
          personalRecordsMode() === 'primary'
        )
          throw await pendingPurchaseOf(operationId);
        throw error;
      });
    if (
      pending.idempotency_key === key &&
      pending.request_hash === marketRequestHash(trade)
    )
      return { rule, operation: await readRuleOperation(pending.id, auth) };
    throw outstandingPurchase();
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
  if (personalRecordsMode() === 'primary')
    await checkedBinding(pending.operation_id);
  let operation: Awaited<ReturnType<typeof readRuleOperation>>;
  try {
    operation = await readRuleOperation(pending.operation_id, auth);
  } catch (error) {
    if (
      error instanceof NotFoundException &&
      personalRecordsMode() === 'primary'
    ) {
      return reconcileWithoutJournal(rule, actor.profileId);
    }
    throw error;
  }
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
  const assets = confirmed
    ? [
        {
          asset_key: operation.asset_key,
          quantity: operation.settlement!.filled_quantity
        }
      ]
    : [];
  // The reviewed unit price times what was filled, as a rebuild checks it.
  return collectingRulesService.settle(
    id,
    actor.profileId,
    {
      operation_id: operation.id,
      status: confirmed ? 'confirmed' : 'reverted',
      transaction_hash: operation.transaction_hash,
      recipient: operation.recipient,
      assets,
      item_cost_wei: itemCost(pending, assets).toString(),
      gas_cost_wei: (receipt.gasUsed * receipt.gasPrice).toString()
    },
    await sentEvidence(operation.transaction_hash, receipt)
  );
}

/**
 * A pending review whose market operation is gone (a rebuild keeps no
 * journal of orders in flight). Without a sent hash, the review is
 * released once its quote has expired, and the person prepares again.
 * With one, Ethereum decides:
 * - mined, once its block is safe: settled with what the receipt shows,
 *   after checking it is the reviewed purchase (from the funding wallet,
 *   to the market contract, paying the reviewed cost). A partial fill
 *   settles what reached the recipient at the reviewed unit price.
 * - never mined: once its quote has expired, Ethereum has no receipt for
 *   it and the funding wallet has mined past its stored nonce (on a safe
 *   block), so nothing can mine it any more, the transaction that used the
 *   nonce decides. The purchase sped up or replaced (to the market
 *   contract, passing the same checks) is settled from it; one that
 *   delivered the reviewed artwork otherwise is a mismatch; anything else
 *   (a cancel, another trade) releases the review. A dropped
 *   transaction stays pending until that nonce is used: the person sends
 *   a replacement at it. A hash kept without a nonce (sent before nonces
 *   were kept) waits to be mined, as before.
 */
async function reconcileWithoutJournal(
  rule: Awaited<ReturnType<typeof collectingRulesService.get>>,
  profileId: string
) {
  const pending = rule.pending_review!;
  const binding = await checkedBinding(pending.operation_id);
  const hash = binding?.transaction_hash ?? null;
  if (!hash) {
    return pending.valid_until <= Date.now()
      ? collectingRulesService.release(rule.id, profileId, pending.operation_id)
      : rule;
  }
  const rpc = marketChain().rpc;
  const [receipt, safe] = await Promise.all([
    rpc.getTransactionReceipt(hash),
    rpc.getBlock('safe')
  ]);
  if (!receipt) {
    const nonce = binding?.transaction_nonce ?? null;
    if (nonce === null || pending.valid_until > Date.now()) return rule;
    const minedNonce = await rpc.getTransactionCount(
      pending.funding_wallet,
      'safe'
    );
    if (minedNonce <= Number(nonce)) return rule;
    // Sped up or replaced, the purchase may have been mined at the same
    // nonce under another hash: that transaction decides.
    const used = await nonceTransactionOnChain(
      rpc,
      pending.funding_wallet,
      Number(nonce)
    );
    if (!used) return rule;
    const outcome = usedNonceOutcome(pending, used);
    if (outcome.kind === 'settle')
      return collectingRulesService.settle(
        rule.id,
        profileId,
        outcome.settlement,
        used
      );
    if (outcome.kind === 'problem')
      throw new CustomApiCompliantException(
        409,
        `The transaction at nonce ${nonce} delivered the reviewed artwork but can't be settled: ${outcome.problem}.`,
        'RECEIPT_MISMATCH'
      );
    return collectingRulesService.release(
      rule.id,
      profileId,
      pending.operation_id,
      {
        transactionHash: hash,
        evidence: {
          transaction: null,
          receipt: null,
          minedNonce: async () => minedNonce,
          nonceTransaction: async () => used
        }
      }
    );
  }
  if (!safe || safe.number < receipt.blockNumber) return rule;
  const canonical = await rpc.getBlock(receipt.blockNumber);
  if (canonical?.hash !== receipt.blockHash)
    throw new CustomApiCompliantException(
      409,
      'The receipt changed. Keep this purchase pending and reconcile again.',
      'RECEIPT_REORG'
    );
  const evidence = await sentEvidence(hash, receipt);
  const settlement = settlementFromReceipt(pending, hash, evidence.receipt!);
  const problem = settlementProblem(settlement, pending, evidence);
  if (problem)
    throw new CustomApiCompliantException(
      409,
      `The purchase can't be settled from its receipt: ${problem}.`,
      'RECEIPT_MISMATCH'
    );
  return collectingRulesService.settle(
    rule.id,
    profileId,
    settlement,
    evidence
  );
}

/**
 * The binding of a rule's pending purchase. A hash kept unchecked (not
 * seen on Ethereum when it was submitted) is checked again first, so it
 * gets its nonce once Ethereum shows it.
 */
async function checkedBinding(operationId: string) {
  const binding = await collectingRulesService.findOperation(operationId);
  if (
    !binding?.transaction_hash ||
    (binding.transaction_nonce !== null &&
      binding.transaction_nonce !== undefined)
  )
    return binding;
  await collectingRulesService.recordSent(
    operationId,
    binding.transaction_hash
  );
  return collectingRulesService.findOperation(operationId);
}

/** What Ethereum shows for a mined hash: its transaction and receipt. */
async function sentEvidence(
  hash: string,
  receipt: TransactionReceipt
): Promise<SentEvidence> {
  const transaction = await marketChain().rpc.getTransaction(hash);
  return {
    transaction: transaction
      ? {
          from: transaction.from,
          to: transaction.to,
          value: transaction.value,
          nonce: transaction.nonce
        }
      : null,
    receipt: {
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.gasPrice,
      logs: receipt.logs
    }
  };
}
