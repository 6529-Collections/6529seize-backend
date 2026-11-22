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
  ModeEvent,
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
  | 'COUNT_FROM_BUILD_LINE'
  | 'MODE_ROLLED_BACK'
  | 'ZERO_BALANCE_AS_ROW';

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

interface CardEvent {
  readonly at: number;
  readonly event: CardRowEvent;
  readonly entry: SubscriptionLogEntry;
}

function cardEvents(
  logs: readonly SubscriptionLogEntry[],
  tokenId: number,
  beforeMs: number,
  useBuildLines: boolean
): CardEvent[] {
  const events: CardEvent[] = [];
  for (const entry of logs) {
    if (entry.createdAtMs >= beforeMs) {
      continue;
    }
    const event = parseCardRowEvent(entry.log, tokenId, entry.additionalInfo);
    if (event && (useBuildLines || event.kind !== 'BUILD_LISTED')) {
      events.push({ at: entry.createdAtMs, event, entry });
    }
  }
  return events;
}

function countFromInfo(info: string | null): number | null {
  const m = /Subscription Count: x(\d+)/.exec(info ?? '');
  return m ? Number(m[1]) : null;
}

interface ModeLine {
  readonly at: number;
  readonly id: number;
  readonly event: ModeEvent;
}

/** Mode lines with fromMs <= time < toMs, oldest first. */
function modeLines(
  logs: readonly SubscriptionLogEntry[],
  fromMs: number,
  toMs: number
): ModeLine[] {
  const lines: ModeLine[] = [];
  for (const entry of logs) {
    if (entry.createdAtMs < fromMs || entry.createdAtMs >= toMs) {
      continue;
    }
    const event = parseModeEvent(entry.log);
    if (event) {
      lines.push({ at: entry.createdAtMs, id: entry.id, event });
    }
  }
  return lines.sort((a, b) => a.id - b.id);
}

interface ModeState {
  automatic: boolean;
  all: boolean;
  updatedAtMs: number | null;
}

/**
 * The mode at the build for a snapshot read after it. A mode line is written
 * on every set, changed or not. Each field takes the newest line before the
 * build when there is one; otherwise, if lines were written between the build
 * and the read, the value before the first of them is taken as its opposite
 * (a first set is normally a change). The mode time becomes the newest mode
 * line before the build, or unknown.
 */
function modeBeforeLateLines(
  state: ModeState,
  logs: readonly SubscriptionLogEntry[],
  buildAtMs: number,
  collectedAtMs: number,
  notes: InputNote[]
) {
  const late = modeLines(logs, buildAtMs, collectedAtMs);
  if (late.length === 0) {
    return;
  }
  notes.push('MODE_ROLLED_BACK');
  const before = modeLines(logs, Number.NEGATIVE_INFINITY, buildAtMs);
  const lastBefore = (kind: ModeEvent['kind']) =>
    before.filter((l) => l.event.kind === kind).pop()?.event;
  const firstLate = (kind: ModeEvent['kind']) =>
    late.find((l) => l.event.kind === kind)?.event;

  const autoLate = firstLate('AUTOMATIC');
  if (autoLate?.kind === 'AUTOMATIC') {
    const known = lastBefore('AUTOMATIC');
    state.automatic =
      known?.kind === 'AUTOMATIC' ? known.automatic : !autoLate.automatic;
  }
  const allLate = firstLate('ALL_EDITIONS');
  if (allLate?.kind === 'ALL_EDITIONS') {
    const known = lastBefore('ALL_EDITIONS');
    state.all = known?.kind === 'ALL_EDITIONS' ? known.all : !allLate.all;
  }
  state.updatedAtMs = before[before.length - 1]?.at ?? null;
}

/**
 * The mode at the build: the snapshot's, set back for lines written after
 * the build (a late read) and rolled forward with lines written between the
 * read and the build (an early read). A mode that is neither automatic nor
 * all-editions reads the same as no mode row.
 */
function modeAt(
  subscriber: SubscriberSnapshot,
  logs: readonly SubscriptionLogEntry[],
  buildAtMs: number,
  notes: InputNote[]
): SubscriptionModeState | null {
  const details = subscriber.details;
  const state: ModeState = {
    automatic: details?.automatic ?? false,
    all: details?.subscribe_all_editions ?? false,
    updatedAtMs:
      details?.automatic && details.last_update > 0 ? details.last_update : null
  };
  if (subscriber.collectedAtMs > buildAtMs) {
    modeBeforeLateLines(
      state,
      logs,
      buildAtMs,
      subscriber.collectedAtMs,
      notes
    );
  }
  for (const line of modeLines(logs, subscriber.collectedAtMs + 1, buildAtMs)) {
    const event = line.event;
    if (event.kind === 'AUTOMATIC' && event.automatic !== state.automatic) {
      state.automatic = event.automatic;
      state.updatedAtMs = line.at;
    }
    if (event.kind === 'ALL_EDITIONS' && event.all !== state.all) {
      state.all = event.all;
      state.updatedAtMs = line.at;
    }
  }
  if (!state.automatic && !state.all) {
    return null;
  }
  return {
    automatic: state.automatic,
    subscribeAllEditions: state.all,
    updatedAtMs: state.updatedAtMs
  };
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
function cardFromEvents(newestFirst: readonly CardEvent[]): {
  card: { subscribed: boolean; count: number } | null;
  countFromBuildLine: boolean;
} {
  let card: { subscribed: boolean; count: number } | null = null;
  let countFromBuildLine = false;
  for (const { event, entry } of newestFirst.slice().reverse()) {
    let count: number;
    if (event.kind === 'COUNT_SET') {
      count = event.count;
      countFromBuildLine = false;
    } else if (event.kind === 'BUILD_LISTED') {
      count = card?.count ?? event.count ?? 1;
      countFromBuildLine = countFromBuildLine || card === null;
    } else {
      const info = countFromInfo(entry.additionalInfo);
      count = info ?? card?.count ?? 1;
      countFromBuildLine = info === null && countFromBuildLine;
    }
    card = { subscribed: event.kind !== 'UNSUBSCRIBED', count };
  }
  return { card, countFromBuildLine };
}

function rollCardForward(
  card: { subscribed: boolean; count: number } | null,
  later: readonly CardEvent[]
): { subscribed: boolean; count: number } | null {
  let current = card;
  for (const { event, entry } of later) {
    if (event.kind === 'SUBSCRIBED' || event.kind === 'MODE_SUBSCRIBED') {
      current = {
        subscribed: true,
        count: countFromInfo(entry.additionalInfo) ?? current?.count ?? 1
      };
    } else if (event.kind === 'UNSUBSCRIBED') {
      current = { subscribed: false, count: current?.count ?? 1 };
    } else if (event.kind === 'COUNT_SET') {
      current = { subscribed: current?.subscribed ?? true, count: event.count };
    }
  }
  return current;
}

function cardAt(
  subscriber: SubscriberSnapshot,
  logs: readonly SubscriptionLogEntry[],
  tokenId: number,
  window: { buildAtMs: number; cutoffMs: number; useBuildLines: boolean },
  notes: InputNote[]
): CardSubscriptionState | null {
  const events = cardEvents(
    logs,
    tokenId,
    Math.min(window.buildAtMs, window.cutoffMs),
    window.useBuildLines
  );
  let card: { subscribed: boolean; count: number } | null;
  if (subscriber.upcoming === null) {
    notes.push('CARD_FROM_LOGS');
    const fromLogs = cardFromEvents(events);
    if (fromLogs.countFromBuildLine) {
      notes.push('COUNT_FROM_BUILD_LINE');
    }
    card = fromLogs.card;
  } else {
    card = rollCardForward(
      initialCard(subscriber, events.length > 0),
      events
        .filter((e) => e.at > subscriber.collectedAtMs)
        .sort((a, b) => a.entry.id - b.entry.id)
    );
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
 * The engine's inputs at the build, from a snapshot. Log lines read later
 * (`laterLogs`, by key) roll each key forward to the build: mode and edition
 * changes, and card changes up to the cutoff. Balances come from the
 * snapshot unless `balances` gives a figure for a key. The public details
 * route answers 0 both for a zero balance and for no balance row; 0 is read
 * as a row holding 0, and noted.
 *
 * `useBuildLines` lets an earlier day's build line stand in for a card row
 * that no other line shows. Build lines are legacy outputs, so the gate mode
 * turns this off.
 */
export function toBuildInputs(
  snapshot: ParitySnapshot,
  params: {
    readonly buildAtMs: number;
    readonly laterLogs?: ReadonlyMap<string, readonly SubscriptionLogEntry[]>;
    readonly balances?: ReadonlyMap<string, number | null>;
    readonly useBuildLines?: boolean;
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
    let balance: number | null = subscriber.details?.balance ?? null;
    if (params.balances?.has(subscriber.key)) {
      balance = params.balances.get(subscriber.key) ?? null;
    } else if (balance === 0) {
      keyNotes.push('ZERO_BALANCE_AS_ROW');
    }
    inputs.push({
      key: subscriber.key,
      balance,
      mode: modeAt(subscriber, logs, params.buildAtMs, keyNotes),
      card: cardAt(
        subscriber,
        logs,
        snapshot.tokenId,
        {
          buildAtMs: params.buildAtMs,
          cutoffMs: snapshot.cutoffMs,
          useBuildLines: params.useBuildLines ?? true
        },
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
