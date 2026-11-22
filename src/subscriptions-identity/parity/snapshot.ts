import { MEMES_CONTRACT } from '@/constants';
import {
  CardSubscriptionState,
  SubscriberBuildInput,
  SubscriptionModeState
} from '../engine/final-list';
import { compareText } from '../engine/text-order';
import { parseCsv } from './csv';
import {
  LegacyDetails,
  LegacyLog,
  LegacySubscriptionsApi,
  LegacyUpcomingStatus
} from './legacy-api';
import {
  CardRowEvent,
  cardRowAutomaticFlag,
  parseCardRowEvent,
  parseModeEvent,
  SubscriptionLogEntry
} from './subscription-logs';

/** One key's public subscription state, as read before the list build. */
export interface SubscriberSnapshot {
  readonly key: string;
  readonly collectedAtMs: number;
  readonly details: LegacyDetails | null;
  readonly upcoming: LegacyUpcomingStatus | null;
  readonly airdrop: {
    readonly airdropAddress: string;
    readonly tdhWallet: string;
  } | null;
  /** Newest first. */
  readonly logs: SubscriptionLogEntry[];
}

export interface ParitySnapshot {
  readonly version: 1;
  readonly contract: string;
  readonly tokenId: number;
  /** When the card closes to changes (mint day 00:00 UTC). */
  readonly cutoffMs: number;
  readonly collectedFromMs: number;
  readonly collectedToMs: number;
  readonly subscribers: SubscriberSnapshot[];
}

export function toLogEntry(log: LegacyLog): SubscriptionLogEntry {
  return {
    id: log.id,
    createdAtMs: Date.parse(log.created_at),
    log: log.log,
    additionalInfo: log.additional_info ?? null
  };
}

/**
 * Candidate keys: every key on the newest `recentLists` published lists of
 * the contract, plus any given keys. A subscriber who never made a recent
 * list and is not given is not read; the comparison names such keys if the
 * legacy list has them.
 */
export async function candidateKeys(
  api: LegacySubscriptionsApi,
  params: {
    readonly contract?: string;
    readonly recentLists: number;
    readonly extraKeys?: readonly string[];
  }
): Promise<string[]> {
  const contract = params.contract ?? MEMES_CONTRACT;
  const keys = new Set(
    (params.extraKeys ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean)
  );
  if (params.recentLists > 0) {
    const uploads = (
      await api.uploads(contract, Math.ceil(params.recentLists / 20))
    )
      .slice()
      .sort((a, b) => b.token_id - a.token_id)
      .slice(0, params.recentLists);
    for (const upload of uploads) {
      const rows = parseCsv(await api.fileText(upload.upload_url));
      for (const row of rows) {
        if (row.consolidation_key) {
          keys.add(row.consolidation_key.toLowerCase());
        }
      }
    }
  }
  return Array.from(keys).sort(compareText);
}

export async function collectSnapshot(
  api: LegacySubscriptionsApi,
  params: {
    readonly contract?: string;
    readonly tokenId: number;
    readonly cutoffMs: number;
    readonly keys: readonly string[];
    readonly logsSinceMs: number;
    readonly now?: () => number;
    readonly onProgress?: (done: number, total: number) => void;
  }
): Promise<ParitySnapshot> {
  const now = params.now ?? (() => Date.now());
  const contract = params.contract ?? MEMES_CONTRACT;
  const collectedFromMs = now();
  const subscribers: SubscriberSnapshot[] = [];
  for (const key of params.keys) {
    const collectedAtMs = now();
    const details = await api.details(key);
    const upcoming = await api.upcomingStatus(key, params.tokenId);
    const airdrop = await api.airdropAddress(key);
    const logs = (await api.logs(key, params.logsSinceMs)).map(toLogEntry);
    subscribers.push({
      key,
      collectedAtMs,
      details,
      upcoming,
      airdrop: airdrop
        ? {
            airdropAddress: airdrop.airdrop_address.address.toLowerCase(),
            tdhWallet: airdrop.tdh_wallet.address.toLowerCase()
          }
        : null,
      logs
    });
    params.onProgress?.(subscribers.length, params.keys.length);
  }
  return {
    version: 1,
    contract,
    tokenId: params.tokenId,
    cutoffMs: params.cutoffMs,
    collectedFromMs,
    collectedToMs: now(),
    subscribers
  };
}

export type InputNote =
  | 'NO_DETAILS'
  | 'COLLECTED_AFTER_CUTOFF'
  | 'ROW_FLAG_UNKNOWN'
  | 'ROW_FLAG_AMBIGUOUS'
  | 'ROW_TIME_UNKNOWN'
  | 'LATER_LOGS_APPLIED'
  | 'CARD_FROM_LOGS'
  | 'MODE_ROLLED_BACK';

export interface BuildInputs {
  readonly inputs: SubscriberBuildInput[];
  readonly notes: ReadonlyMap<string, InputNote[]>;
}

function mergeLogs(
  older: readonly SubscriptionLogEntry[],
  newer: readonly SubscriptionLogEntry[] | undefined
): SubscriptionLogEntry[] {
  const byId = new Map<number, SubscriptionLogEntry>();
  for (const entry of [...older, ...(newer ?? [])]) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((a, b) => b.id - a.id);
}

function cardEvents(
  logs: readonly SubscriptionLogEntry[],
  tokenId: number,
  beforeMs: number
): Array<{ at: number; event: CardRowEvent; entry: SubscriptionLogEntry }> {
  const events: Array<{
    at: number;
    event: CardRowEvent;
    entry: SubscriptionLogEntry;
  }> = [];
  for (const entry of logs) {
    if (entry.createdAtMs >= beforeMs) {
      continue;
    }
    const event = parseCardRowEvent(entry.log, tokenId, entry.additionalInfo);
    if (event) {
      events.push({ at: entry.createdAtMs, event, entry });
    }
  }
  return events;
}

function countFromInfo(info: string | null): number | null {
  const m = /Subscription Count: x(\d+)/.exec(info ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Undoes mode lines written between the build and the read, newest first,
 * for a snapshot read after the build. A line is written on every set, so
 * each is taken as a change from the opposite value; the mode time becomes
 * the newest mode line before the build, or unknown.
 */
function rollBackMode(
  state: { automatic: boolean; all: boolean; updatedAtMs: number | null },
  subscriber: SubscriberSnapshot,
  logs: readonly SubscriptionLogEntry[],
  buildAtMs: number,
  notes: InputNote[]
) {
  const afterBuild = logs
    .filter(
      (e) =>
        e.createdAtMs >= buildAtMs && e.createdAtMs < subscriber.collectedAtMs
    )
    .sort((a, b) => b.id - a.id);
  let rolledBack = false;
  for (const entry of afterBuild) {
    const event = parseModeEvent(entry.log);
    if (event?.kind === 'AUTOMATIC') {
      state.automatic = !event.automatic;
      rolledBack = true;
    } else if (event?.kind === 'ALL_EDITIONS') {
      state.all = !event.all;
      rolledBack = true;
    }
  }
  if (!rolledBack) {
    return;
  }
  notes.push('MODE_ROLLED_BACK');
  const before = logs
    .filter((e) => e.createdAtMs < buildAtMs && parseModeEvent(e.log))
    .sort((a, b) => b.id - a.id)[0];
  state.updatedAtMs = before?.createdAtMs ?? null;
}

function modeAt(
  subscriber: SubscriberSnapshot,
  logs: readonly SubscriptionLogEntry[],
  buildAtMs: number,
  notes: InputNote[]
): SubscriptionModeState | null {
  const details = subscriber.details;
  const state = {
    automatic: details?.automatic ?? false,
    all: details?.subscribe_all_editions ?? false,
    updatedAtMs:
      details?.automatic && details.last_update > 0
        ? details.last_update
        : (null as number | null)
  };
  let exists =
    !!details && (details.automatic || details.subscribe_all_editions);
  if (subscriber.collectedAtMs > buildAtMs) {
    rollBackMode(state, subscriber, logs, buildAtMs, notes);
  }
  let { automatic, all, updatedAtMs } = state;
  const later = logs
    .filter(
      (e) =>
        e.createdAtMs > subscriber.collectedAtMs && e.createdAtMs < buildAtMs
    )
    .sort((a, b) => a.id - b.id);
  for (const entry of later) {
    const event = parseModeEvent(entry.log);
    if (!event) {
      continue;
    }
    exists = true;
    if (event.kind === 'AUTOMATIC' && event.automatic !== automatic) {
      automatic = event.automatic;
      updatedAtMs = entry.createdAtMs;
    }
    if (event.kind === 'ALL_EDITIONS' && event.all !== all) {
      all = event.all;
      updatedAtMs = entry.createdAtMs;
    }
  }
  if (!exists) {
    return null;
  }
  return { automatic, subscribeAllEditions: all, updatedAtMs };
}

function initialCard(
  subscriber: SubscriberSnapshot,
  hasRowEvents: boolean
): { subscribed: boolean; count: number } | null {
  const status = subscriber.upcoming;
  if (status?.subscribed && status.source === 'manual') {
    return { subscribed: true, count: status.count ?? 1 };
  }
  if (status?.subscribed) {
    return null;
  }
  return hasRowEvents ? { subscribed: false, count: 1 } : null;
}

/**
 * The card row from its log lines alone (oldest to newest), for when the
 * status route gave nothing (the card has dropped, or the read failed).
 */
function cardFromEvents(
  newestFirst: ReadonlyArray<{
    event: CardRowEvent;
    entry: SubscriptionLogEntry;
  }>
): { subscribed: boolean; count: number } | null {
  let card: { subscribed: boolean; count: number } | null = null;
  for (const { event, entry } of newestFirst.slice().reverse()) {
    let count: number;
    if (event.kind === 'COUNT_SET') {
      count = event.count;
    } else if (event.kind === 'BUILD_LISTED') {
      count = card?.count ?? event.count ?? 1;
    } else {
      count = countFromInfo(entry.additionalInfo) ?? card?.count ?? 1;
    }
    card = {
      subscribed: event.kind !== 'UNSUBSCRIBED',
      count
    };
  }
  return card;
}

function cardAt(
  subscriber: SubscriberSnapshot,
  logs: readonly SubscriptionLogEntry[],
  tokenId: number,
  buildAtMs: number,
  cutoffMs: number,
  notes: InputNote[]
): CardSubscriptionState | null {
  const events = cardEvents(logs, tokenId, Math.min(buildAtMs, cutoffMs));
  const fromLogs = subscriber.upcoming === null;
  if (fromLogs) {
    notes.push('CARD_FROM_LOGS');
  }
  let card = fromLogs
    ? cardFromEvents(events)
    : initialCard(subscriber, events.length > 0);
  const later = events
    .filter((e) => !fromLogs && e.at > subscriber.collectedAtMs)
    .sort((a, b) => a.entry.id - b.entry.id);
  for (const { event, entry } of later) {
    if (event.kind === 'SUBSCRIBED' || event.kind === 'MODE_SUBSCRIBED') {
      card = {
        subscribed: true,
        count: countFromInfo(entry.additionalInfo) ?? card?.count ?? 1
      };
    } else if (event.kind === 'UNSUBSCRIBED') {
      card = { subscribed: false, count: card?.count ?? 1 };
    } else if (event.kind === 'COUNT_SET') {
      card = { subscribed: card?.subscribed ?? true, count: event.count };
    }
  }
  if (!card) {
    return null;
  }
  const rowEvents = events.filter((e) => e.event.kind !== 'BUILD_LISTED');
  const flag = cardRowAutomaticFlag(rowEvents.map((e) => e.event));
  if (flag.automatic === null) {
    notes.push('ROW_FLAG_UNKNOWN');
  }
  if (flag.ambiguous) {
    notes.push('ROW_FLAG_AMBIGUOUS');
  }
  const newest = rowEvents[0]?.at ?? null;
  if (newest === null) {
    notes.push('ROW_TIME_UNKNOWN');
  }
  return {
    subscribed: card.subscribed,
    subscribedCount: card.count,
    automaticSubscription: flag.automatic ?? false,
    updatedAtMs: newest
  };
}

/**
 * The engine's inputs at the build, from a snapshot read before it. Log
 * lines read later (`laterLogs`, by key) roll each key forward to the build:
 * mode and edition changes, and card changes up to the cutoff. Balances
 * come from the snapshot unless `pinnedBalances` gives the legacy build's
 * own figure for a key.
 */
export function toBuildInputs(
  snapshot: ParitySnapshot,
  params: {
    readonly buildAtMs: number;
    readonly laterLogs?: ReadonlyMap<string, readonly SubscriptionLogEntry[]>;
    readonly pinnedBalances?: ReadonlyMap<string, number | null>;
  }
): BuildInputs {
  const notes = new Map<string, InputNote[]>();
  const inputs: SubscriberBuildInput[] = [];
  for (const subscriber of snapshot.subscribers) {
    const keyNotes: InputNote[] = [];
    if (!subscriber.details) {
      keyNotes.push('NO_DETAILS');
    }
    if (subscriber.collectedAtMs >= snapshot.cutoffMs) {
      keyNotes.push('COLLECTED_AFTER_CUTOFF');
    }
    const later = params.laterLogs?.get(subscriber.key);
    if (later?.some((e) => e.createdAtMs > subscriber.collectedAtMs)) {
      keyNotes.push('LATER_LOGS_APPLIED');
    }
    const logs = mergeLogs(subscriber.logs, later);
    const pinned = params.pinnedBalances?.has(subscriber.key)
      ? (params.pinnedBalances.get(subscriber.key) ?? null)
      : undefined;
    const snapshotBalance =
      subscriber.details && subscriber.details.balance !== 0
        ? subscriber.details.balance
        : null;
    inputs.push({
      key: subscriber.key,
      balance: pinned === undefined ? snapshotBalance : pinned,
      mode: modeAt(subscriber, logs, params.buildAtMs, keyNotes),
      card: cardAt(
        subscriber,
        logs,
        snapshot.tokenId,
        params.buildAtMs,
        snapshot.cutoffMs,
        keyNotes
      ),
      eligibility: Math.max(
        1,
        subscriber.details?.subscription_eligibility_count ?? 1
      )
    });
    notes.set(subscriber.key, keyNotes);
  }
  return { inputs, notes };
}
