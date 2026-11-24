import { entryDropIdOf } from './waves-chain-mirror.ids';
import {
  ChainDecisionState,
  ChainEntryRow,
  ChainResultRow,
  TargetEntry
} from './waves-chain-mirror.types';

/** How many rows a table would get, change and lose. */
export interface TableChanges {
  insert: number;
  update: number;
  delete: number;
}

/** Counts a plan's writes by table, and the chain rows that wait. */
export class PlanCounter {
  readonly changes: Record<string, TableChanges> = {};
  readonly waiting: Record<string, number> = {};

  change(table: string, kind: keyof TableChanges, n = 1) {
    if (n <= 0) return;
    const counts = (this.changes[table] ??= {
      insert: 0,
      update: 0,
      delete: 0
    });
    counts[kind] += n;
  }

  wait(reason: string, n = 1) {
    if (n <= 0) return;
    this.waiting[reason] = (this.waiting[reason] ?? 0) + n;
  }
}

/** Adds one plan's counts to a running total. */
export function addChanges(
  total: Record<string, TableChanges>,
  changes: Record<string, TableChanges>
) {
  for (const [table, c] of Object.entries(changes)) {
    const t = (total[table] ??= { insert: 0, update: 0, delete: 0 });
    t.insert += c.insert;
    t.update += c.update;
    t.delete += c.delete;
  }
}

export function addCounts(
  total: Record<string, number>,
  counts: Record<string, number>
) {
  for (const [key, n] of Object.entries(counts)) {
    total[key] = (total[key] ?? 0) + n;
  }
}

/**
 * Each chain entry's 6529.io entry row: an imported entry's by its drop id
 * (the legacy id), an entry made on the chain's by its chain id as drop id.
 * Entries 6529.io has no row of are left out.
 */
export function mapEntries(
  chainEntries: readonly ChainEntryRow[],
  targetEntries: readonly TargetEntry[]
): Map<string, TargetEntry> {
  const byDrop = new Map(targetEntries.map((e) => [e.dropId.toLowerCase(), e]));
  const out = new Map<string, TargetEntry>();
  for (const entry of chainEntries) {
    const target = byDrop.get(entryDropIdOf(entry));
    if (target) out.set(entry.entryId, target);
  }
  return out;
}

/**
 * A decimal amount from the chain as a JavaScript number, or null when it
 * doesn't fit exactly (6529.io's columns are bigint, read as numbers).
 */
export function safeAmount(
  text: string | number | null | undefined
): number | null {
  if (text === null || text === undefined) return null;
  if (!/^-?[0-9]+$/.test(String(text))) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A time field (ms) of an object, or null when unset (0) or unreadable. */
export function timeOf(value: unknown): number | null {
  const time = Number(value);
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

/** The results of a decision the chain counted (final, not imported). */
export function chainFinalResults(
  chain: Pick<ChainDecisionState, 'results'>
): ChainResultRow[] {
  return chain.results
    .filter((r) => r.stage === 'final' && r.origin === 'native')
    .sort((a, b) => a.resultTime - b.resultTime);
}

const MINUTE = 60_000;
/** The longest wait between two tries of something delayed. */
const MAX_RETRY_DELAY_MS = 6 * 60 * MINUTE;

/** The wait before try `attempts + 1`: 1, 2, 4 ... minutes, up to 6 hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, MINUTE * 2 ** Math.max(0, attempts - 1));
}

/**
 * From when a decision's weighted ratings need score history: the time
 * lock before its next result time (the leaderboard's decision rating)
 * and before its newest result (the winners' votes). Null for a decision
 * the chain doesn't count.
 */
export function historySinceOf(chain: ChainDecisionState): number | null {
  const from = historyFromOf(chain);
  return from === null ? null : from - chainTimeLockOf(chain);
}

function chainTimeLockOf(chain: ChainDecisionState): number {
  const config = (chain.decision.data.config ?? {}) as Record<string, unknown>;
  return Math.max(0, Number(config.timeLock ?? 0) || 0);
}

/** The earliest time the read history weighs at: the next or newest result. */
function historyFromOf(chain: ChainDecisionState): number | null {
  if (chain.decision.data.counted !== true) return null;
  const times = [
    chain.decision.status === 'published' ? chain.decision.nextResultTime : 0,
    chainFinalResults(chain).at(-1)?.resultTime ?? 0
  ].filter((t) => t > 0);
  return times.length ? Math.min(...times) : null;
}

/**
 * Whether the score history a run reads covers a result's time lock, so
 * its winners' votes can be weighted (the newest result's, and any after).
 */
export function historyCoversResult(
  chain: ChainDecisionState,
  resultTime: number
): boolean {
  const from = historyFromOf(chain);
  return from !== null && resultTime >= from;
}

/**
 * The score history a decision's plan weighs: from `since` (historySinceOf)
 * for its ACTIVE entries (the board's decision ratings), and the VOTER
 * series of its newest result's winners (their voters' votes), by drop id.
 */
export interface HistoryRead {
  readonly since: number;
  readonly winnerDropIds: readonly string[];
}

export function historyReadOf(chain: ChainDecisionState): HistoryRead | null {
  const since = historySinceOf(chain);
  if (since === null) return null;
  const newest = chainFinalResults(chain).at(-1);
  const winners = Array.isArray(newest?.data.winners)
    ? (newest.data.winners as unknown[])
    : [];
  const entries = new Map(chain.entries.map((e) => [e.entryId, e]));
  const winnerDropIds = winners.flatMap((w) => {
    const entryId = (w as Record<string, unknown> | null)?.entryId;
    const entry =
      typeof entryId === 'string' ? entries.get(entryId.toLowerCase()) : null;
    return entry ? [entryDropIdOf(entry)] : [];
  });
  return { since, winnerDropIds };
}
