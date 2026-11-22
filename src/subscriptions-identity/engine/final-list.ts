import { MEMES_MINT_PRICE } from '@/constants';
import {
  resolveFinalSubscriptionCount,
  resolveRequestedSubscriptionCount
} from '@/subscriptionsDaily/subscription-final-count';
import { affordableCardCount } from './parity-money';

export interface SubscriptionModeState {
  readonly automatic: boolean;
  readonly subscribeAllEditions: boolean;
  /** The mode row's updated_at in ms. It orders automatic subscribers. */
  readonly updatedAtMs: number | null;
}

export interface CardSubscriptionState {
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
  /** The card row's updated_at in ms. It orders manual subscribers. */
  readonly updatedAtMs: number | null;
}

export interface SubscriberBuildInput {
  readonly key: string;
  /** null when the subscriber has no balance row. */
  readonly balance: number | null;
  /** null when the subscriber has no mode row. */
  readonly mode: SubscriptionModeState | null;
  /** The subscriber's row for the card being built, or null. */
  readonly card: CardSubscriptionState | null;
  /** Card-set eligibility for the latest season, at least 1. */
  readonly eligibility: number;
}

export interface AirdropTarget {
  readonly airdropAddress: string | null;
  readonly tdhWallet: string | null;
}

export interface FinalListRow {
  readonly key: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribedCount: number;
  readonly airdropAddress: string | null;
  readonly balance: number;
  readonly subscribedAt: string;
}

export type FinalListDecision =
  | {
      readonly kind: 'ADDED';
      readonly key: string;
      readonly count: number;
      readonly requested: number;
      readonly affordable: number;
      readonly eligibility: number;
      readonly airdropAddress: string | null;
      readonly balance: number;
    }
  | {
      readonly kind: 'INSUFFICIENT_BALANCE';
      readonly key: string;
      readonly balance: number;
    }
  | { readonly kind: 'NO_BALANCE'; readonly key: string }
  | {
      readonly kind: 'NO_COUNT';
      readonly key: string;
      readonly requested: number;
      readonly eligibility: number;
    };

export interface FinalListBuild {
  /** In the legacy list's order. */
  readonly rows: FinalListRow[];
  /** One per subscribed key, ascending by key. */
  readonly decisions: FinalListDecision[];
  /** Rows the build adds for automatic subscribers with no row for the card. */
  readonly autoPopulated: ReadonlyArray<{
    readonly key: string;
    readonly subscribedCount: number;
  }>;
  /**
   * Automatic subscribers short of balance: the legacy build sets their mode
   * row's updated_at to the build time, which moves them back in later lists.
   */
  readonly queuePushedKeys: string[];
}

export interface FinalListBuildParams {
  readonly contract: string;
  readonly tokenId: number;
  readonly buildAtMs: number;
  readonly subscribers: readonly SubscriberBuildInput[];
  readonly resolveAirdrop: (key: string) => AirdropTarget;
  readonly mintPrice?: number;
}

function compareKeys(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function withCardRow(
  subscriber: SubscriberBuildInput,
  buildAtMs: number
): { input: SubscriberBuildInput; populatedCount: number | null } {
  if (subscriber.card || !subscriber.mode?.automatic) {
    return { input: subscriber, populatedCount: null };
  }
  const subscribedCount = subscriber.mode.subscribeAllEditions
    ? subscriber.eligibility
    : 1;
  return {
    input: {
      ...subscriber,
      card: {
        subscribed: true,
        subscribedCount,
        automaticSubscription: true,
        updatedAtMs: buildAtMs
      }
    },
    populatedCount: subscribedCount
  };
}

function subscribedAtFor(
  subscriber: SubscriberBuildInput,
  card: CardSubscriptionState,
  buildAtMs: number
): string {
  const ms = subscriber.mode?.automatic
    ? (subscriber.mode.updatedAtMs ?? buildAtMs)
    : (card.updatedAtMs ?? buildAtMs);
  return new Date(ms).toISOString();
}

/** The legacy order: subscribed_at ascending, then balance descending. */
export function compareFinalListRows(
  a: Pick<FinalListRow, 'subscribedAt' | 'balance'>,
  d: Pick<FinalListRow, 'subscribedAt' | 'balance'>
): number {
  if (a.subscribedAt === d.subscribedAt) {
    return d.balance - a.balance;
  }
  return a.subscribedAt < d.subscribedAt ? -1 : 1;
}

/**
 * Builds one card's final subscription list from the subscribers' state at
 * the build, by the legacy daily loop's rules (subscriptionsDaily
 * populateAutoSubscriptionsForMemeId and createFinalSubscriptions). Pure: the
 * caller supplies balances, modes, card rows, eligibility and airdrop targets.
 *
 * The legacy loop pushes rows in the order its database calls finish, so rows
 * equal in subscribed_at and balance have no fixed order there. Here they are
 * ordered by key; positions are compared as information only.
 */
export function buildFinalList(params: FinalListBuildParams): FinalListBuild {
  const mintPrice = params.mintPrice ?? MEMES_MINT_PRICE;
  const subscribers = Array.from(
    new Map(
      params.subscribers.map((s) => [
        s.key.toLowerCase(),
        { ...s, key: s.key.toLowerCase() }
      ])
    ).values()
  ).sort((a, b) => compareKeys(a.key, b.key));

  const autoPopulated: { key: string; subscribedCount: number }[] = [];
  const rows: FinalListRow[] = [];
  const decisions: FinalListDecision[] = [];
  const queuePushedKeys: string[] = [];

  for (const original of subscribers) {
    const { input, populatedCount } = withCardRow(original, params.buildAtMs);
    if (populatedCount !== null) {
      autoPopulated.push({ key: input.key, subscribedCount: populatedCount });
    }
    const card = input.card;
    if (!card?.subscribed) {
      continue;
    }
    if (input.balance === null) {
      decisions.push({ kind: 'NO_BALANCE', key: input.key });
      continue;
    }
    if (!(input.balance >= mintPrice)) {
      decisions.push({
        kind: 'INSUFFICIENT_BALANCE',
        key: input.key,
        balance: input.balance
      });
      if (input.mode?.automatic) {
        queuePushedKeys.push(input.key);
      }
      continue;
    }
    const affordable = affordableCardCount(input.balance, mintPrice);
    const requested = resolveRequestedSubscriptionCount(
      {
        subscribed_count: card.subscribedCount,
        automatic_subscription: card.automaticSubscription
      },
      input.mode?.automatic
        ? { subscribe_all_editions: input.mode.subscribeAllEditions }
        : undefined,
      input.eligibility
    );
    const count = resolveFinalSubscriptionCount(
      input.eligibility,
      requested,
      affordable
    );
    if (count === null) {
      decisions.push({
        kind: 'NO_COUNT',
        key: input.key,
        requested,
        eligibility: input.eligibility
      });
      continue;
    }
    const target = params.resolveAirdrop(input.key);
    rows.push({
      key: input.key,
      contract: params.contract,
      tokenId: params.tokenId,
      subscribedCount: count,
      airdropAddress: target.airdropAddress,
      balance: input.balance,
      subscribedAt: subscribedAtFor(input, card, params.buildAtMs)
    });
    decisions.push({
      kind: 'ADDED',
      key: input.key,
      count,
      requested,
      affordable,
      eligibility: input.eligibility,
      airdropAddress: target.airdropAddress,
      balance: input.balance
    });
  }

  rows.sort(compareFinalListRows);
  return { rows, decisions, autoPopulated, queuePushedKeys };
}
