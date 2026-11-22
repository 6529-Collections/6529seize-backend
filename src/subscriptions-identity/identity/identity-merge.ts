import { mergeUpcomingSubscriptions } from '@/subscriptionsDaily/subscription-merge';
import { compareText } from '../engine/text-order';

/*
 * The one merge rule for two or more subscription states that come to
 * belong to one identity (owner question O2). The cut uses it for keys of
 * one identity whose legacy re-key was held back; the top-up loop uses it
 * when a wallet binds to an identity after the opening. It is the legacy
 * merge (consolidateSubscriptions): balances summed; a fresh mode row at the
 * merge time, automatic and all editions kept if any part had them; choices
 * for the same card combined as mergeUpcomingSubscriptions does, the first
 * part's row surviving. A wallet that leaves an identity takes nothing.
 */

export interface MergeBalance {
  readonly balance: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MergeMode {
  readonly automatic: boolean;
  readonly subscribeAllEditions: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MergeChoice {
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
  readonly createdAt: string;
  /** The database's datetime text; it orders subscribers. */
  readonly updatedAt: string;
}

export interface MergeState {
  readonly balance: MergeBalance | null;
  readonly mode: MergeMode | null;
  readonly choices: readonly MergeChoice[];
}

/** Two rows for one card, as the legacy merge combines them (text times). */
export function foldChoice(
  surviving: MergeChoice,
  merged: MergeChoice
): MergeChoice {
  const state = (c: MergeChoice) => ({
    subscribed: c.subscribed,
    automatic_subscription: c.automaticSubscription,
    subscribed_count: c.subscribedCount,
    updated_at: new Date(`${c.updatedAt.replace(' ', 'T').slice(0, 23)}Z`)
  });
  const survivingState = state(surviving);
  const combined = mergeUpcomingSubscriptions(survivingState, state(merged));
  if (combined === survivingState) {
    // Neither row is subscribed: the surviving row stays as it was.
    return surviving;
  }
  // The earlier priority time of the subscribed rows, to the microsecond.
  const updatedAt = [surviving, merged]
    .filter((c) => c.subscribed)
    .map((c) => c.updatedAt)
    .sort(compareText)[0];
  return {
    ...surviving,
    subscribed: combined.subscribed,
    automaticSubscription: combined.automatic_subscription,
    subscribedCount: combined.subscribed_count,
    updatedAt
  };
}

/** Merges states in order (the first survives) at `atText`. */
export function mergeStates(
  parts: readonly MergeState[],
  atText: string
): MergeState {
  const balances = parts
    .map((p) => p.balance)
    .filter((b): b is MergeBalance => b !== null);
  const modes = parts
    .map((p) => p.mode)
    .filter((m): m is MergeMode => m !== null);
  const choices = new Map<string, MergeChoice>();
  for (const part of parts) {
    for (const choice of part.choices) {
      const card = `${choice.contract}|${choice.tokenId}`;
      const surviving = choices.get(card);
      choices.set(card, surviving ? foldChoice(surviving, choice) : choice);
    }
  }
  return {
    balance:
      balances.length > 0
        ? {
            balance: balances.reduce((sum, b) => sum + b.balance, 0),
            createdAt: atText,
            updatedAt: atText
          }
        : null,
    mode: {
      automatic: modes.some((m) => m.automatic),
      subscribeAllEditions: modes.some((m) => m.subscribeAllEditions),
      createdAt: atText,
      updatedAt: atText
    },
    choices: Array.from(choices.values())
  };
}
