import { hasMinimumBalanceForAutomaticMode } from '@/api/subscriptions/insufficient-subscription-balance.exception';
import { mergeUpcomingSubscriptions } from '@/subscriptionsDaily/subscription-merge';
import { roundSubscriptionBalance } from '../engine/parity-money';
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

type Choice = Omit<OpeningChoice, 'identityKey'>;

/** Folds two rows for one card as the legacy merge does, keeping date text. */
function foldChoice(surviving: Choice, merged: Choice): Choice {
  const state = (c: Choice) => ({
    subscribed: c.subscribed,
    automatic_subscription: c.automaticSubscription,
    subscribed_count: c.subscribedCount,
    updated_at: new Date(`${c.updatedAt.replace(' ', 'T')}Z`)
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
  const map = mapCurrentKeys(currentKeys, byWallet);
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
  const isMerged = (identity: string) => map.shared.has(identity);

  const balanceByKey = new Map(
    tables.balances.map((r) => [r.consolidation_key, r])
  );
  const modeByKey = new Map(tables.modes.map((r) => [r.consolidation_key, r]));
  const balances = new Map<string, OpeningBalance>();
  const modes = new Map<string, OpeningMode>();
  for (const [identity, keys] of Array.from(keysOf.entries())) {
    const keyBalances = keys
      .map((k) => balanceByKey.get(k))
      .filter((b): b is NonNullable<typeof b> => !!b);
    const keyModes = keys
      .map((k) => modeByKey.get(k))
      .filter((m): m is NonNullable<typeof m> => !!m);
    if (!isMerged(identity)) {
      const b = keyBalances[0];
      if (b) {
        balances.set(identity, {
          identityKey: identity,
          balance: Number(b.balance),
          createdAt: b.created_at,
          updatedAt: b.updated_at
        });
      }
      const m = keyModes[0];
      if (m) {
        modes.set(identity, {
          identityKey: identity,
          automatic: flag(m.automatic),
          subscribeAllEditions: flag(m.subscribe_all_editions),
          createdAt: m.created_at,
          updatedAt: m.updated_at
        });
      }
      continue;
    }
    // The legacy merge writes fresh balance and mode rows.
    if (keyBalances.length > 0) {
      balances.set(identity, {
        identityKey: identity,
        balance: keyBalances.reduce((sum, b) => sum + Number(b.balance), 0),
        createdAt: cutText,
        updatedAt: cutText
      });
    }
    modes.set(identity, {
      identityKey: identity,
      automatic: keyModes.some((m) => flag(m.automatic)),
      subscribeAllEditions: keyModes.some((m) =>
        flag(m.subscribe_all_editions)
      ),
      createdAt: cutText,
      updatedAt: cutText
    });
  }

  const choices = new Map<string, OpeningChoice>();
  const openChoices = tables.choices
    .filter((r) => open(r.token_id))
    .sort((a, b) => compareText(a.consolidation_key, b.consolidation_key));
  for (const r of openChoices) {
    const identityKey = identityOf(r.consolidation_key);
    const id = `${identityKey}|${r.contract}|${Number(r.token_id)}`;
    const row: Choice = {
      contract: r.contract,
      tokenId: Number(r.token_id),
      subscribed: flag(r.subscribed),
      subscribedCount: Number(r.subscribed_count),
      automaticSubscription: flag(r.automatic_subscription),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
    const surviving = choices.get(id);
    choices.set(id, {
      identityKey,
      ...(surviving ? foldChoice(surviving, row) : row)
    });
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
      case 'CONSOLIDATION':
        note('MERGED_AT_CUT');
        break;
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
