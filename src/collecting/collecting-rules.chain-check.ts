import { id as eventTopic, zeroPadValue } from 'ethers';
import { MARKET_SEAPORT } from '@/marketplace/seaport.registry';
import type {
  CollectingRuleReview,
  CollectingRuleSettlement
} from './collecting-rules.types';

/** The parts of a transaction receipt a settlement is checked against. */
export interface SettlementReceipt {
  readonly status: number | null;
  readonly gasUsed: bigint;
  readonly gasPrice: bigint;
  readonly logs: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
}

/** The parts of the sent transaction a purchase is checked against. */
export interface SentTransaction {
  readonly from: string;
  readonly to: string | null;
  readonly value: bigint;
  readonly nonce: number;
}

/** What Ethereum shows for a sent hash: its transaction and its receipt. */
export interface SentEvidence {
  readonly transaction: SentTransaction | null;
  readonly receipt: SettlementReceipt | null;
  /** A wallet's next nonce on a safe block: every lower one is mined. */
  readonly minedNonce?: (wallet: string) => Promise<number>;
  /** The mined transaction that used a wallet's nonce, up to a safe block. */
  readonly nonceTransaction?: (
    wallet: string,
    nonce: number
  ) => Promise<NonceTransaction | null>;
}

/** A mined transaction at a wallet's nonce, with its receipt. */
export interface NonceTransaction {
  readonly hash: string;
  readonly transaction: SentTransaction;
  readonly receipt: SettlementReceipt;
}

/**
 * What a sent purchase whose transaction can never be mined comes to, by
 * the transaction that used its nonce instead (sped up or replaced):
 * - the reviewed purchase after all (to the market contract, and it passes
 *   settlementProblem): settled from that transaction;
 * - one that delivered reviewed assets but isn't the reviewed purchase:
 *   a problem, settled by hand;
 * - anything else (a cancel, another trade): released.
 */
export function usedNonceOutcome(
  review: CollectingRuleReview,
  used: NonceTransaction
):
  | { readonly kind: 'settle'; readonly settlement: CollectingRuleSettlement }
  | { readonly kind: 'release' }
  | { readonly kind: 'problem'; readonly problem: string } {
  if (used.transaction.to?.toLowerCase() !== MARKET_SEAPORT) {
    return { kind: 'release' };
  }
  const settlement = settlementFromReceipt(review, used.hash, used.receipt);
  const problem = settlementProblem(settlement, review, used);
  if (!problem) return { kind: 'settle', settlement };
  return settlement.assets.length
    ? { kind: 'problem', problem }
    : { kind: 'release' };
}

/**
 * Why a sent purchase can't be released as never mined, or null when it
 * can: Ethereum has no receipt for its hash, and the funding wallet has
 * mined past its nonce, so nothing can mine that transaction any more.
 */
export function unminedProblem(
  receipt: SettlementReceipt | null,
  nonce: number | null,
  minedNonce: number
): string | null {
  if (nonce === null) return "the sent transaction's nonce is not known";
  if (receipt) return 'the sent transaction was mined';
  if (minedNonce <= nonce) {
    return `nonce ${nonce} is not used yet, so the transaction can still be mined`;
  }
  return null;
}

const ERC721_TRANSFER = eventTopic('Transfer(address,address,uint256)');
const ERC1155_TRANSFER_SINGLE = eventTopic(
  'TransferSingle(address,address,address,uint256,uint256)'
);

const topicOfAddress = (address: string) =>
  zeroPadValue(address.toLowerCase(), 32).toLowerCase();
const topicOfNumber = (value: string) =>
  `0x${BigInt(value).toString(16).padStart(64, '0')}`;

/** How many of `assetKey` (`1:<contract>:<token>`) the receipt moved to `to`. */
function receivedQuantity(
  receipt: SettlementReceipt,
  assetKey: string,
  to: string
): bigint {
  const [, contract, token] = assetKey.split(':');
  const toTopic = topicOfAddress(to);
  const tokenTopic = topicOfNumber(token);
  let received = BigInt(0);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) continue;
    const topics = log.topics.map((topic) => topic.toLowerCase());
    if (
      topics[0] === ERC721_TRANSFER &&
      topics[2] === toTopic &&
      topics[3] === tokenTopic
    ) {
      received += BigInt(1);
    } else if (
      topics[0] === ERC1155_TRANSFER_SINGLE &&
      topics[3] === toTopic &&
      log.data.length === 2 + 128 &&
      BigInt(`0x${log.data.slice(2, 66)}`) === BigInt(token)
    ) {
      received += BigInt(`0x${log.data.slice(66)}`);
    }
  }
  return received;
}

/**
 * Why a sent transaction isn't the reviewed purchase, or null when it is:
 * it comes from the review's funding wallet, calls the market contract and
 * pays exactly the reviewed item cost (rules buy with ETH only).
 */
export function sentTransactionProblem(
  review: CollectingRuleReview,
  transaction: SentTransaction | null
): string | null {
  if (!transaction) return 'the transaction is not visible on Ethereum';
  if (transaction.from.toLowerCase() !== review.funding_wallet.toLowerCase()) {
    return "the transaction is not from the rule's funding wallet";
  }
  if (transaction.to?.toLowerCase() !== MARKET_SEAPORT) {
    return 'the transaction does not call the market contract';
  }
  if (transaction.value !== BigInt(review.item_cost_wei)) {
    return 'the transaction does not pay the reviewed cost';
  }
  return null;
}

/**
 * The settlement a mined receipt shows for a review: a confirmed purchase
 * gets what reached the recipient, up to the reviewed quantity (a fill can
 * be partial), at the reviewed unit price; a reverted one gets nothing.
 */
export function settlementFromReceipt(
  review: CollectingRuleReview,
  transactionHash: string,
  receipt: SettlementReceipt
): CollectingRuleSettlement {
  const confirmed = receipt.status === 1;
  const assets = confirmed
    ? review.assets
        .map((asset) => {
          const received = receivedQuantity(
            receipt,
            asset.asset_key,
            review.recipient
          );
          const reviewed = BigInt(asset.quantity);
          return {
            asset_key: asset.asset_key,
            quantity: (received < reviewed ? received : reviewed).toString()
          };
        })
        .filter((asset) => asset.quantity !== '0')
    : [];
  return {
    operation_id: review.operation_id,
    status: confirmed ? 'confirmed' : 'reverted',
    transaction_hash: transactionHash,
    recipient: review.recipient,
    assets,
    item_cost_wei: itemCost(review, assets).toString(),
    gas_cost_wei: (receipt.gasUsed * receipt.gasPrice).toString()
  };
}

/** The reviewed unit prices times the quantities bought. */
export function itemCost(
  review: CollectingRuleReview,
  assets: CollectingRuleSettlement['assets']
): bigint {
  return assets.reduce((total, asset) => {
    const reviewed = review.assets.find(
      (item) => item.asset_key === asset.asset_key
    );
    return reviewed
      ? total + BigInt(reviewed.unit_price_wei) * BigInt(asset.quantity)
      : total;
  }, BigInt(0));
}

/**
 * Why a settlement does not match Ethereum, or null when it does:
 * - the transaction is the reviewed purchase (sentTransactionProblem);
 * - the receipt's status, and the gas cost (gasUsed x gasPrice, as
 *   reconcile computes it);
 * - for a confirmed purchase, each asset reached the recipient and the
 *   item cost is the reviewed unit price times what was bought.
 * A rebuild applies only settlements that match, so neither the spend nor
 * the assets can be made up.
 */
export function settlementProblem(
  settlement: CollectingRuleSettlement,
  review: CollectingRuleReview,
  evidence: SentEvidence
): string | null {
  if (settlement.status !== 'confirmed' && settlement.status !== 'reverted') {
    return `a ${settlement.status} settlement is not from a mined transaction`;
  }
  const { receipt } = evidence;
  if (!receipt) return 'no receipt for the transaction';
  const sent = sentTransactionProblem(review, evidence.transaction);
  if (sent) return sent;
  const confirmed = settlement.status === 'confirmed';
  if (receipt.status !== (confirmed ? 1 : 0)) {
    return `the receipt's status is ${receipt.status}`;
  }
  if (
    (receipt.gasUsed * receipt.gasPrice).toString() !== settlement.gas_cost_wei
  ) {
    return 'the gas cost differs from the receipt';
  }
  if (confirmed && settlement.assets.length === 0) {
    return 'a confirmed purchase bought nothing';
  }
  for (const asset of settlement.assets) {
    if (
      receivedQuantity(receipt, asset.asset_key, settlement.recipient) <
      BigInt(asset.quantity)
    ) {
      return `${asset.asset_key} did not reach the recipient`;
    }
  }
  if (
    itemCost(review, settlement.assets).toString() !== settlement.item_cost_wei
  ) {
    return 'the item cost is not the reviewed price of what was bought';
  }
  return null;
}
