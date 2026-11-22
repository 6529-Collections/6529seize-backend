import { hasMinimumBalanceForAutomaticMode } from '@/api/subscriptions/insufficient-subscription-balance.exception';
import { roundSubscriptionBalance } from '../engine/parity-money';
import {
  MergeChoice,
  MergeState,
  mergeStates
} from '../identity/identity-merge';
import { compareText } from '../engine/text-order';
import {
  identitiesOfKey,
  mapCurrentKeys,
  WalletIdentities
} from './opening-attribution';
import {
  BlockedKey,
  HistoryLog,
  MergedIdentity,
  OpeningBalance,
  OpeningChoice,
  OpeningMode,
  OpeningTopUp,
  QueuedNote
} from './opening-file';
import {
  flag,
  LegacyTables,
  msToDbText,
  queuePayload,
  QueuedTopUp
} from './legacy-tables';

/*
 * The current state at the cut, by identity: balances, modes and choices
 * for open cards. Two steps the legacy system would have taken, had the
 * key-width guard not held them back, are taken here:
 *
 * 1. Keys of one identity are merged by the legacy merge rules
 *    (consolidateSubscriptions): balances summed; automatic and all
 *    editions kept if any key had them, on a fresh mode row; choices for
 *    the same card combined as mergeUpcomingSubscriptions does.
 * 2. Waiting top-ups are credited to the sender's identity as resolved at
 *    the cut, in queue order, with the legacy top-up arithmetic: a first
 *    top-up opens the balance unrounded and, if it covers a card, turns
 *    automatic mode on; later ones add and round to five decimals.
 *
 * A key that spans identities (a split), and a waiting redemption, block
 * the cut.
 */

export interface CurrentState {
  readonly identityOf: (consolidationKey: string) => string;
  readonly balances: OpeningBalance[];
  readonly modes: OpeningMode[];
  readonly choices: OpeningChoice[];
  readonly merged: MergedIdentity[];
  readonly blocked: BlockedKey[];
  /** Waiting top-ups credited at the cut. */
  readonly creditedTopUps: OpeningTopUp[];
  /** Waiting log lines, for the history file. */
  readonly queuedLogs: HistoryLog[];
  readonly queued: QueuedNote[];
}

export function currentState(
  cut: { readonly at: string; readonly maxMemeId: number },
  tables: LegacyTables,
  byWallet: WalletIdentities
): CurrentState {
  const cutText = msToDbText(Date.parse(cut.at));
  const open = (tokenId: number | string) => Number(tokenId) > cut.maxMemeId;
  const currentKeys = new Set<string>([
    ...tables.balances.map((r) => r.consolidation_key),
    ...tables.modes.map((r) => r.consolidation_key),
    ...tables.choices
      .filter((r) => open(r.token_id))
      .map((r) => r.consolidation_key),
    ...tables.finalRows
      .filter((r) => open(r.token_id))
      .map((r) => r.consolidation_key)
  ]);
  // Re-keys the key-width guard held back: old key -> the identity of the
  // new key the legacy re-key chose for it.
  const decisions = new Map<string, string>();
  for (const entry of tables.queue) {
    if (entry.kind !== 'CONSOLIDATION') {
      continue;
    }
    const { newKey, oldKeys } = queuePayload<{
      newKey: string;
      oldKeys: string[];
    }>(entry);
    const target = identitiesOfKey(newKey, byWallet);
    if (target.length === 1) {
      for (const oldKey of oldKeys) {
        decisions.set(oldKey.toLowerCase(), target[0]);
      }
    }
  }
  const map = mapCurrentKeys(currentKeys, byWallet, (key) =>
    decisions.get(key.toLowerCase())
  );
  const splitsApplied = new Set(
    Array.from(map.identityOf.keys()).filter(
      (key) => identitiesOfKey(key, byWallet).length > 1
    )
  );
  const identityOf = (key: string) =>
    map.identityOf.get(key) ?? identitiesOfKey(key, byWallet)[0];
  const blocked: BlockedKey[] = [...map.blocked];

  // Keys per identity, in fold order (sorted; the first survives).
  const keysOf = new Map<string, string[]>();
  for (const key of Array.from(currentKeys).sort(compareText)) {
    const identity = identityOf(key);
    keysOf.set(identity, [...(keysOf.get(identity) ?? []), key]);
  }
  const merged: MergedIdentity[] = Array.from(map.shared.entries())
    .map(([identityKey, consolidationKeys]) => ({
      identityKey,
      consolidationKeys: [...consolidationKeys]
    }))
    .sort((a, b) => compareText(a.identityKey, b.identityKey));
  // Each identity's state from its keys, in fold order. A key alone moves
  // as it is; keys of one identity are merged by the one merge rule
  // (identity-merge.ts), at the cut's time.
  const balanceByKey = new Map(
    tables.balances.map((r) => [r.consolidation_key, r])
  );
  const modeByKey = new Map(tables.modes.map((r) => [r.consolidation_key, r]));
  const choicesByKey = new Map<string, MergeChoice[]>();
  for (const r of tables.choices.filter((c) => open(c.token_id))) {
    choicesByKey.set(r.consolidation_key, [
      ...(choicesByKey.get(r.consolidation_key) ?? []),
      {
        contract: r.contract,
        tokenId: Number(r.token_id),
        subscribed: flag(r.subscribed),
        subscribedCount: Number(r.subscribed_count),
        automaticSubscription: flag(r.automatic_subscription),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }
    ]);
  }
  const stateOfKey = (key: string): MergeState => {
    const b = balanceByKey.get(key);
    const m = modeByKey.get(key);
    return {
      balance: b
        ? {
            balance: Number(b.balance),
            createdAt: b.created_at,
            updatedAt: b.updated_at
          }
        : null,
      mode: m
        ? {
            automatic: flag(m.automatic),
            subscribeAllEditions: flag(m.subscribe_all_editions),
            createdAt: m.created_at,
            updatedAt: m.updated_at
          }
        : null,
      choices: choicesByKey.get(key) ?? []
    };
  };
  const balances = new Map<string, OpeningBalance>();
  const modes = new Map<string, OpeningMode>();
  const choices = new Map<string, OpeningChoice>();
  for (const [identity, keys] of Array.from(keysOf.entries())) {
    const state = map.shared.has(identity)
      ? mergeStates(keys.map(stateOfKey), cutText)
      : stateOfKey(keys[0]);
    if (state.balance) {
      balances.set(identity, { identityKey: identity, ...state.balance });
    }
    if (state.mode) {
      modes.set(identity, { identityKey: identity, ...state.mode });
    }
    for (const choice of state.choices) {
      choices.set(`${identity}|${choice.contract}|${choice.tokenId}`, {
        identityKey: identity,
        ...choice
      });
    }
  }

  const creditedTopUps: OpeningTopUp[] = [];
  const queuedLogs: HistoryLog[] = [];
  const queued: QueuedNote[] = [];
  const credited = new Set(tables.topUps.map((t) => t.hash.toLowerCase()));
  const queue = [...tables.queue].sort(
    (a, b) => Number(a.sequence) - Number(b.sequence)
  );
  for (const entry of queue) {
    const sequence = Number(entry.sequence);
    const keyIdentity = identitiesOfKey(entry.consolidation_key, byWallet)[0];
    const note = (effect: QueuedNote['effect'], identityKey = keyIdentity) =>
      queued.push({
        sequence,
        kind: entry.kind,
        consolidationKey: entry.consolidation_key,
        identityKey,
        effect
      });
    switch (entry.kind) {
      case 'TOP_UP': {
        const { topUp } = queuePayload<{ topUp: QueuedTopUp }>(entry);
        const sender = topUp.from_wallet.toLowerCase();
        const identity = byWallet.get(sender) ?? sender;
        if (credited.has(topUp.hash.toLowerCase())) {
          note('TOP_UP_ALREADY_CREDITED', identity);
          break;
        }
        credited.add(topUp.hash.toLowerCase());
        const amount = Number(topUp.amount);
        const before = balances.get(identity);
        if (before) {
          balances.set(identity, {
            ...before,
            balance: roundSubscriptionBalance(before.balance + amount),
            updatedAt: cutText
          });
        } else {
          balances.set(identity, {
            identityKey: identity,
            balance: amount,
            createdAt: cutText,
            updatedAt: cutText
          });
          if (hasMinimumBalanceForAutomaticMode(amount)) {
            // As the legacy mode change on a first top-up: the mode line,
            // then every open card the identity had unsubscribed from (a
            // person can unsubscribe with no balance) subscribed again,
            // with a line each. The legacy change also sets automatic rows'
            // counts to the eligibility when all editions are on; the cut
            // reads no eligibility, so those counts stay as they are until
            // the identity's next count change. Only an identity of more
            // wallets than the key columns hold can have a waiting top-up,
            // and none can exist before the key-width migration.
            const at = msToDbText(Date.parse(topUp.transaction_date));
            queuedLogs.push({
              legacyId: null,
              queueSequence: sequence,
              identityKey: identity,
              consolidationKey: entry.consolidation_key,
              log: 'Subscription Mode set to Automatic',
              additionalInfo: null,
              createdAt: at
            });
            const unsubscribed = Array.from(choices.entries())
              .filter(
                ([, choice]) =>
                  choice.identityKey === identity && !choice.subscribed
              )
              .sort(([, x], [, y]) => x.tokenId - y.tokenId);
            for (const [choiceKey, choice] of unsubscribed) {
              choices.set(choiceKey, {
                ...choice,
                subscribed: true,
                updatedAt: at
              });
              queuedLogs.push({
                legacyId: null,
                queueSequence: sequence,
                identityKey: identity,
                consolidationKey: entry.consolidation_key,
                log: `Subscribed to Meme #${choice.tokenId}`,
                additionalInfo: null,
                createdAt: at
              });
            }
            const mode = modes.get(identity);
            modes.set(identity, {
              identityKey: identity,
              automatic: true,
              subscribeAllEditions: mode?.subscribeAllEditions ?? false,
              createdAt: mode?.createdAt ?? cutText,
              updatedAt: cutText
            });
          }
        }
        creditedTopUps.push({
          hash: topUp.hash,
          block: Number(topUp.block),
          transactionDate: msToDbText(Date.parse(topUp.transaction_date)),
          fromWallet: topUp.from_wallet,
          amount,
          identityKey: identity,
          createdAt: cutText
        });
        note('TOP_UP_CREDITED', identity);
        break;
      }
      case 'LOG': {
        const log = queuePayload<{
          log: string;
          additional_info?: string | null;
        }>(entry);
        for (const identityKey of identitiesOfKey(
          entry.consolidation_key,
          byWallet
        )) {
          queuedLogs.push({
            legacyId: null,
            queueSequence: sequence,
            identityKey,
            consolidationKey: entry.consolidation_key,
            log: log.log,
            additionalInfo: log.additional_info ?? null,
            createdAt: msToDbText(Number(entry.created_at))
          });
        }
        note('LOG_CARRIED');
        break;
      }
      case 'CONSOLIDATION': {
        const { newKey, oldKeys } = queuePayload<{
          newKey: string;
          oldKeys: string[];
        }>(entry);
        const target = identitiesOfKey(newKey, byWallet)[0];
        if (oldKeys.some((k) => splitsApplied.has(k))) {
          note('SPLIT_APPLIED_AT_CUT', target);
        } else if (map.shared.has(target)) {
          note('MERGED_AT_CUT', target);
        } else {
          note('NOTHING_TO_APPLY', target);
        }
        break;
      }
      case 'REDEMPTION':
        if (
          !blocked.some(
            (b) =>
              b.reason === 'PENDING_REDEMPTION' &&
              b.consolidationKey === entry.consolidation_key
          )
        ) {
          blocked.push({
            consolidationKey: entry.consolidation_key,
            reason: 'PENDING_REDEMPTION',
            identities: identitiesOfKey(entry.consolidation_key, byWallet)
          });
        }
        note('BLOCKS_THE_CUT');
        break;
      default:
        // FINAL_ROW and AUTO_SUBSCRIPTION: the next daily build decides.
        note('LEFT_TO_THE_BUILD');
    }
  }

  const byIdentity = <T extends { identityKey: string }>(a: T, b: T) =>
    compareText(a.identityKey, b.identityKey);
  return {
    identityOf,
    balances: Array.from(balances.values()).sort(byIdentity),
    modes: Array.from(modes.values()).sort(byIdentity),
    choices: Array.from(choices.values()).sort(
      (a, b) =>
        compareText(a.identityKey, b.identityKey) ||
        compareText(a.contract, b.contract) ||
        a.tokenId - b.tokenId
    ),
    merged,
    blocked: blocked.sort(
      (a, b) =>
        compareText(a.consolidationKey, b.consolidationKey) ||
        compareText(a.reason, b.reason)
    ),
    creditedTopUps,
    queuedLogs,
    queued
  };
}
