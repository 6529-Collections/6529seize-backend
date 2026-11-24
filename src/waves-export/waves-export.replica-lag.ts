import {
  errorCode,
  readReplicaLag,
  REPLICA_LAG_AGE_MARGIN_MS,
  ReplicaLagReading
} from '@/dbDumpsDaily/chain-exports/replica-snapshot';
import { ReplicaLagCheckedBy, WavesExportUsageError } from './cli-options';

/**
 * The read replica's lag, checked before any stage reads. The export reads
 * through the shared DB layer's pool on DB_HOST, several connections at once,
 * and the reader endpoint can put each on a different Aurora reader with its
 * own lag. One reader's own row, which the chain exports read
 * (REPLICA_LAG_SQL in dbDumpsDaily/chain-exports/replica-snapshot.ts), says
 * nothing for the others, so this reads every reader's row and holds the
 * worst to the bound. It also reads whether DB_HOST's server is read-only,
 * as the chain exports do: a server that isn't is the writer, not a reader.
 */

/**
 * Every row of information_schema.replica_host_status: the lag and age
 * columns of REPLICA_LAG_SQL, the server and session (the writer's session
 * is MASTER_SESSION_ID), and the server's clock in the same statement.
 */
export const ALL_READERS_LAG_SQL =
  'SELECT SERVER_ID AS server_id, SESSION_ID AS session_id, REPLICA_LAG_IN_MILLISECONDS AS lag_ms, TIMESTAMPDIFF(MICROSECOND, LAST_UPDATE_TIMESTAMP, UTC_TIMESTAMP(6)) / 1000 AS age_ms, ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS now_ms FROM information_schema.replica_host_status';

/** The server's read_only, as openReadOnlySnapshot reads it. */
export const READ_ONLY_SQL = 'SELECT @@GLOBAL.read_only AS ro';
/** Aurora readers report innodb_read_only; read on its own, as it may fail. */
export const INNODB_READ_ONLY_SQL = 'SELECT @@GLOBAL.innodb_read_only AS iro';

const WRITER_SESSION_ID = 'MASTER_SESSION_ID';

/**
 * A reader's row this old is no fresh reading: the reader may have stopped
 * updating it, so its lag can't be known and waiting won't help.
 */
export const STALE_READING_MS = 60_000;

/** What one reading saw, as export.json records it. Lag figures in ms. */
export interface ReplicaLagSeen {
  /** This machine's clock or the server's, the earlier. */
  readonly read_at: string;
  /** Whether DB_HOST's server is read-only (a reader); null when unknown. */
  readonly server_read_only: boolean | null;
  /** Readers in replica_host_status, the writer's server left out. */
  readonly readers: number | null;
  /** The reader furthest behind, by lag plus its row's age: its lag, up. */
  readonly worst_lag_ms: number | null;
  /** That reader's row's age when read, rounded up. */
  readonly worst_lag_age_ms: number | null;
  /** Readers whose row is STALE_READING_MS old or more. */
  readonly stale_readers: number | null;
  /** Why the export couldn't tell; null when it could. */
  readonly unknown_reason: string | null;
}

/** export.json's `replica_lag` for one run. */
export type ReplicaLagRecord =
  | ({ readonly checked_by: 'export' } & ReplicaLagSeen)
  | ({
      readonly checked_by: 'person';
      readonly person: string;
      readonly note: string;
    } & ReplicaLagSeen)
  | ({ readonly checked_by: 'rehearsal' } & ReplicaLagSeen);

export interface ReplicaLagReadOptions {
  /** Runs a SELECT through the export's own DB context, as its reads do. */
  readonly readRows: (sql: string) => Promise<unknown[]>;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

export interface ReplicaLagCheckOptions extends ReplicaLagReadOptions {
  /** Five minutes after the freeze: every reader must have caught up past it. */
  readonly caughtUpMs: number;
  /**
   * --replica-lag-checked-by and --replica-lag-check-note: taken only when
   * the export can't tell (an unknown lag or read-only state, or a reader's
   * row that stopped updating), never over a lag it can read.
   */
  readonly checkedByPerson?: ReplicaLagCheckedBy | null;
}

export interface ReplicaLagStartOptions extends ReplicaLagReadOptions {
  /** Null for a rehearsal, which reads and reports but never refuses. */
  readonly caughtUpMs: number | null;
  readonly checkedByPerson: ReplicaLagCheckedBy | null;
}

interface LagRow {
  readonly server_id?: unknown;
  readonly session_id?: unknown;
  readonly lag_ms?: unknown;
  readonly age_ms?: unknown;
  readonly now_ms?: unknown;
}

interface ReaderLag {
  readonly lagMs: number;
  readonly ageMs: number;
}

/** Everything one reading saw. */
interface ServerReading {
  readonly readMs: number;
  readonly readOnly: boolean | null;
  readonly readOnlyUnknown: string | null;
  /** Every reader's lag, or why it can't be known. */
  readonly lag:
    | { readonly known: true; readonly readers: readonly ReaderLag[] }
    | {
        readonly known: false;
        readonly readers: number | null;
        readonly reason: string;
      };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function flag(value: unknown): boolean | null {
  const number = numberOrNull(value);
  return number === null ? null : number === 1;
}

/**
 * Each reader's newest row, as REPLICA_LAG_SQL picks one for its own reader
 * (LAST_UPDATE_TIMESTAMP DESC: the youngest age first, no timestamp last).
 * Every row of a server with a writer's row is left out, so a row the
 * writer kept from a reader session before a failover can't block a run.
 */
function newestRowPerReader(rows: readonly unknown[]): LagRow[] {
  const all = rows.map((value) => (value ?? {}) as LagRow);
  const writers = new Set(
    all
      .filter((row) => row.session_id === WRITER_SESSION_ID)
      .map((row) => String(row.server_id))
  );
  const newest = new Map<string, LagRow>();
  for (const row of all) {
    const reader = String(row.server_id);
    if (writers.has(reader)) continue;
    const kept = newest.get(reader);
    const age = numberOrNull(row.age_ms);
    const keptAge = kept ? numberOrNull(kept.age_ms) : null;
    if (!kept || (age !== null && (keptAge === null || age < keptAge))) {
      newest.set(reader, row);
    }
  }
  return Array.from(newest.values());
}

/**
 * One row read by the chain exports' own rules (readReplicaLag): a null or
 * negative lag, a null timestamp, or a row dated ahead of UTC is unknown.
 */
function readRow(row: LagRow): Promise<ReplicaLagReading> {
  const oneRow = {
    query: (_sql: string, callback: (error: null, rows: LagRow[]) => void) =>
      callback(null, [row])
  };
  return readReplicaLag(oneRow as never);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const oneOf = (count: number) =>
  count === 1 ? 'its one reader' : `one of its ${count} readers`;
const furthest = (count: number, onFreshRows = false) =>
  count === 1
    ? 'its one reader'
    : `of its ${count} readers, the one furthest behind` +
      (onFreshRows ? ' on an up-to-date row' : '');
const failed = (what: string, error: unknown) =>
  `reading ${what} failed (${errorCode(error)})`;

/** A UTC time, with its date when that isn't the reading's day. */
function utcTime(ms: number, todayMs: number): string {
  const iso = new Date(ms).toISOString();
  const day = iso.slice(0, 10);
  return day === new Date(todayMs).toISOString().slice(0, 10)
    ? `${iso.slice(11, 19)} UTC`
    : `${day} ${iso.slice(11, 19)} UTC`;
}

function logError(
  options: ReplicaLagReadOptions,
  what: string,
  error: unknown
) {
  // The message can name the user and host: the log only, never export.json.
  options.log(
    `${what} not read: ${String((error as Error)?.message ?? error)}`
  );
}

async function readReadOnly(
  options: ReplicaLagReadOptions
): Promise<{ readOnly: boolean | null; unknown: string | null }> {
  let ro: boolean | null;
  try {
    const [row] = await options.readRows(READ_ONLY_SQL);
    ro = flag((row as { ro?: unknown } | undefined)?.ro);
  } catch (error) {
    logError(options, 'read_only', error);
    return { readOnly: null, unknown: failed('@@GLOBAL.read_only', error) };
  }
  let iro: boolean | null = null;
  try {
    const [row] = await options.readRows(INNODB_READ_ONLY_SQL);
    iro = flag((row as { iro?: unknown } | undefined)?.iro);
  } catch {
    iro = null;
  }
  if (ro === true || iro === true) return { readOnly: true, unknown: null };
  if (ro === false && iro === false) return { readOnly: false, unknown: null };
  return {
    readOnly: null,
    unknown: "DB_HOST's server did not say whether it is read-only"
  };
}

/** Reads the server's state and every reader's lag; never throws for either. */
async function readServer(
  options: ReplicaLagReadOptions
): Promise<ServerReading> {
  const { readOnly, unknown: readOnlyUnknown } = await readReadOnly(options);
  const localMs = (options.now ?? Date.now)();
  const reading = (lag: ServerReading['lag'], readMs = localMs) => ({
    readMs,
    readOnly,
    readOnlyUnknown,
    lag
  });
  let rows: unknown[];
  try {
    rows = await options.readRows(ALL_READERS_LAG_SQL);
  } catch (error) {
    logError(options, 'replica lag', error);
    return reading({
      known: false,
      readers: null,
      reason: failed('information_schema.replica_host_status', error)
    });
  }
  const readers = newestRowPerReader(rows);
  if (!readers.length) {
    return reading({
      known: false,
      readers: 0,
      reason: 'information_schema.replica_host_status has no row for any reader'
    });
  }
  const lags: ReaderLag[] = [];
  for (const row of readers) {
    const { lagMs, ageMs, unknown, error } = await readRow(row);
    if (unknown || lagMs === null || ageMs === null) {
      return reading({
        known: false,
        readers: readers.length,
        reason: `the row of ${oneOf(readers.length)} says ${error}`
      });
    }
    lags.push({ lagMs, ageMs });
  }
  const serverMs = numberOrNull(readers[0].now_ms);
  if (serverMs === null || serverMs <= 0) {
    return reading({
      known: false,
      readers: readers.length,
      reason: "the server's clock could not be read"
    });
  }
  return reading({ known: true, readers: lags }, Math.min(localMs, serverMs));
}

const behindOf = (reader: ReaderLag) =>
  reader.lagMs + reader.ageMs + REPLICA_LAG_AGE_MARGIN_MS;

function worstOf(readers: readonly ReaderLag[]): ReaderLag {
  return readers.reduce((a, b) =>
    b.lagMs + b.ageMs > a.lagMs + a.ageMs ? b : a
  );
}

/** What export.json records of a reading. */
function seen(
  reading: ServerReading,
  unknownReason: string | null
): ReplicaLagSeen {
  const { lag } = reading;
  const worst = lag.known ? worstOf(lag.readers) : null;
  return {
    read_at: new Date(reading.readMs).toISOString(),
    server_read_only: reading.readOnly,
    readers: lag.known ? lag.readers.length : lag.readers,
    worst_lag_ms: worst ? Math.ceil(worst.lagMs) : null,
    worst_lag_age_ms: worst ? Math.ceil(worst.ageMs) : null,
    stale_readers: lag.known
      ? lag.readers.filter((it) => it.ageMs >= STALE_READING_MS).length
      : null,
    unknown_reason: unknownReason
  };
}

/** How the reading stands against the bound. */
type Verdict =
  | { readonly kind: 'not_read_only' }
  | {
      readonly kind: 'behind';
      readonly worst: ReaderLag;
      readonly readers: number;
      /** Readers whose row stopped updating also block, and are left out. */
      readonly staleLeftOut: boolean;
    }
  | { readonly kind: 'cannot_tell'; readonly reasons: string }
  | { readonly kind: 'caught_up' };

/**
 * A reader at most lag plus age plus the chain exports' margin
 * (REPLICA_LAG_AGE_MARGIN_MS) behind, less than the time since `caughtUpMs`,
 * has every write that committed before it. A reader past that on a fresh
 * row is behind: only waiting helps. One past it on a row that stopped
 * updating, an unknown lag or an unknown read-only state can't be told.
 */
function verdict(reading: ServerReading, caughtUpMs: number): Verdict {
  if (reading.readOnly === false) return { kind: 'not_read_only' };
  const reasons: string[] = [];
  if (reading.readOnlyUnknown) reasons.push(reading.readOnlyUnknown);
  const { lag } = reading;
  if (lag.known) {
    const gapMs = reading.readMs - caughtUpMs;
    const blocking = lag.readers.filter((it) => behindOf(it) >= gapMs);
    const fresh = blocking.filter((it) => it.ageMs < STALE_READING_MS);
    if (fresh.length) {
      return {
        kind: 'behind',
        worst: worstOf(fresh),
        readers: lag.readers.length,
        staleLeftOut: fresh.length < blocking.length
      };
    }
    if (blocking.length) {
      const oldest = blocking.reduce((a, b) => (b.ageMs > a.ageMs ? b : a));
      reasons.push(
        `the row of ${oneOf(lag.readers.length)} stopped updating ` +
          `${seconds(oldest.ageMs)} ago, so its lag can't be known`
      );
    }
  } else {
    reasons.push(lag.reason);
  }
  return reasons.length
    ? { kind: 'cannot_tell', reasons: reasons.join('; ') }
    : { kind: 'caught_up' };
}

/**
 * The check for a run after the freeze. Refuses a server that isn't
 * read-only, and a reader behind on a fresh row (naming when to try again),
 * whatever a person says. When the export can't tell, it refuses unless a
 * person checked another way (--replica-lag-checked-by and
 * --replica-lag-check-note), and then records them with what it read. When
 * it can tell and every reader has caught up, it refuses those two options.
 */
export async function checkReplicaLag(
  options: ReplicaLagCheckOptions
): Promise<ReplicaLagRecord> {
  const { caughtUpMs, checkedByPerson } = options;
  const reading = await readServer(options);
  const at = (ms: number) => utcTime(ms, reading.readMs);
  const mark = `${at(caughtUpMs)}, five minutes after the freeze`;
  const result = verdict(reading, caughtUpMs);
  switch (result.kind) {
    case 'not_read_only':
      throw new WavesExportUsageError(
        `DB_HOST's server is not read-only (read_only and innodb_read_only ` +
          `are both off), so it is not a read replica, and the export reads ` +
          `only from one. Point DB_HOST at the cluster's reader endpoint, ` +
          `with DB_USER and DB_PASS for it: the export reads through DB_HOST, ` +
          `not DB_HOST_READ.`,
        { showHelp: false }
      );
    case 'behind': {
      const { worst } = result;
      const behindMs = behindOf(worst);
      throw new WavesExportUsageError(
        `The read replica may be up to ${seconds(behindMs)} behind: ` +
          `${furthest(result.readers, result.staleLeftOut)} has a lag of ` +
          `${seconds(worst.lagMs)}, ` +
          `in a reading ${seconds(worst.ageMs)} old, and ` +
          `${seconds(REPLICA_LAG_AGE_MARGIN_MS)} more covers clock and ` +
          `timestamp rounding. The export needs every reader caught up past ` +
          `${mark}. Try again after ` +
          `${at(Math.ceil((caughtUpMs + behindMs) / 1000) * 1000)}.` +
          (checkedByPerson
            ? ` A person's check can't stand in for a lag the export can ` +
              `read: wait until then, and run it without ` +
              `--replica-lag-checked-by and --replica-lag-check-note.`
            : ''),
        { showHelp: false }
      );
    }
    case 'cannot_tell':
      if (!checkedByPerson) {
        throw new WavesExportUsageError(
          `The export can't tell whether every reader has caught up past ` +
            `${mark}: ${result.reasons}. Run it once more first: a passing ` +
            `error or a late row update can clear. If it says the same ` +
            `again, check it another way: read the largest lag over all ` +
            `readers (on Aurora, the AuroraReplicaLagMaximum metric) and make ` +
            `sure DB_HOST is the cluster's reader endpoint. Once that much ` +
            `lag has passed since ${at(caughtUpMs)}, run the export again ` +
            `with --replica-lag-checked-by <your name> ` +
            `--replica-lag-check-note <what you read, its value and when>.`,
          { showHelp: false }
        );
      }
      options.log(
        `WARNING: the export can't tell whether every reader has caught up ` +
          `past ${mark}: ${result.reasons}. It goes ahead on the word of ` +
          `${JSON.stringify(checkedByPerson.person)}, who checked it this ` +
          `way: ${JSON.stringify(checkedByPerson.note)}. export.json records ` +
          `both, with what the export read.`
      );
      return {
        checked_by: 'person',
        person: checkedByPerson.person,
        note: checkedByPerson.note,
        ...seen(reading, result.reasons)
      };
    case 'caught_up': {
      if (checkedByPerson) {
        throw new WavesExportUsageError(
          `The export can read the lag, and every reader has caught up past ` +
            `${mark}: run it without --replica-lag-checked-by and ` +
            `--replica-lag-check-note, which are only for when it can't tell.`,
          { showHelp: false }
        );
      }
      const record = seen(reading, null);
      options.log(
        `read replica: DB_HOST's server is read-only; ` +
          `${furthest(record.readers ?? 0)} has a lag of ` +
          `${record.worst_lag_ms} ms, in a reading ${record.worst_lag_age_ms} ` +
          `ms old; every reader has caught up past ${at(caughtUpMs)}`
      );
      return { checked_by: 'export', ...record };
    }
  }
}

/**
 * A rehearsal's reading: the same queries and rules, logged and recorded,
 * never a refusal. Nothing it meets is fatal, so the rehearsal before the
 * freeze shows whether the queries work on the live readers, and what a run
 * after the freeze would refuse on.
 */
async function rehearseReplicaLag(
  options: ReplicaLagReadOptions
): Promise<ReplicaLagRecord> {
  let reading: ServerReading;
  try {
    reading = await readServer(options);
  } catch (error) {
    logError(options, 'replica lag', error);
    reading = {
      readMs: (options.now ?? Date.now)(),
      readOnly: null,
      readOnlyUnknown: null,
      lag: {
        known: false,
        readers: null,
        reason: failed('information_schema.replica_host_status', error)
      }
    };
  }
  const { lag } = reading;
  const reasons = [
    reading.readOnlyUnknown,
    lag.known ? null : lag.reason
  ].filter((it): it is string => !!it);
  const record = seen(reading, reasons.length ? reasons.join('; ') : null);
  const say = (message: string) => options.log(`rehearsal: ${message}`);
  if (reading.readOnly === false) {
    say(
      "DB_HOST's server is not read-only, so it is not a read replica: a run " +
        "after the freeze would refuse on this. Point DB_HOST at the cluster's " +
        'reader endpoint.'
    );
  }
  if (record.unknown_reason) {
    say(
      `the export can't tell: ${record.unknown_reason}. A run after the ` +
        `freeze would refuse on this unless a person checks it another way.`
    );
  }
  if (lag.known) {
    say(
      `${furthest(lag.readers.length)} has a lag of ${record.worst_lag_ms} ` +
        `ms, in a reading ${record.worst_lag_age_ms} ms old (a rehearsal ` +
        `holds it to no bound)`
    );
    const stale = lag.readers.filter((it) => it.ageMs >= STALE_READING_MS);
    if (stale.length) {
      const oldest = stale.reduce((a, b) => (b.ageMs > a.ageMs ? b : a));
      say(
        `${stale.length} of its ${lag.readers.length} readers' rows are a ` +
          `minute old or more (the oldest ${Math.ceil(oldest.ageMs)} ms): ` +
          `such a reader may have stopped updating its row, and a run after ` +
          `the freeze may refuse on it unless a person checks it another way.`
      );
    }
  }
  return { checked_by: 'rehearsal', ...record };
}

/**
 * export.json's `replica_lag` for this run, settled before any stage reads:
 * a rehearsal's reading, which never refuses, or the check for a run after
 * the freeze (checkReplicaLag).
 */
export async function replicaLagAtStart(
  options: ReplicaLagStartOptions
): Promise<ReplicaLagRecord> {
  const { caughtUpMs, ...rest } = options;
  return caughtUpMs === null
    ? rehearseReplicaLag(rest)
    : checkReplicaLag({ ...rest, caughtUpMs });
}
