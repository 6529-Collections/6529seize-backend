import {
  errorCode,
  readReplicaLag,
  REPLICA_LAG_AGE_MARGIN_MS,
  ReplicaLagReading
} from '@/dbDumpsDaily/chain-exports/replica-snapshot';
import { ReplicaLagCheckedBy, WavesExportUsageError } from './cli-options';

/**
 * The read replica's lag, checked before any stage reads. The export reads
 * through the shared DB layer's pool, several connections at once, and the
 * reader endpoint can put each on a different Aurora reader with its own
 * lag. One reader's own row, which the chain exports read (REPLICA_LAG_SQL in
 * dbDumpsDaily/chain-exports/replica-snapshot.ts), says nothing for the
 * others, so this reads every reader's row and holds the worst to the bound.
 */

/**
 * Every row of information_schema.replica_host_status: the lag and age
 * columns of REPLICA_LAG_SQL, the server and session (the writer's session
 * is MASTER_SESSION_ID), and the server's clock in the same statement.
 */
export const ALL_READERS_LAG_SQL =
  'SELECT SERVER_ID AS server_id, SESSION_ID AS session_id, REPLICA_LAG_IN_MILLISECONDS AS lag_ms, TIMESTAMPDIFF(MICROSECOND, LAST_UPDATE_TIMESTAMP, UTC_TIMESTAMP(6)) / 1000 AS age_ms, ROUND(UNIX_TIMESTAMP(NOW(6)) * 1000) AS now_ms FROM information_schema.replica_host_status';

const WRITER_SESSION_ID = 'MASTER_SESSION_ID';

/**
 * A reader's row this old is no fresh reading: a refusal says the reader
 * may have stopped updating it, so trying again won't pass.
 */
const STALE_READING_MS = 60_000;

/** export.json's `replica_lag` when the export read the lag itself. */
export interface ReplicaLagCheckedByExport {
  readonly checked_by: 'export';
  /** Readers in replica_host_status, the writer left out. */
  readonly readers: number;
  /** The lag of the reader furthest behind (by lag plus age), whole ms up. */
  readonly worst_lag_ms: number;
  /** How old that reader's row was when read, whole ms up. */
  readonly worst_lag_age_ms: number;
  /** When it was read: this machine's clock or the server's, the earlier. */
  readonly read_at: string;
}

/**
 * export.json's `replica_lag` with --replica-lag-checked-by and
 * --replica-lag-check-note: who checked the lag instead of the export, and
 * how.
 */
export interface ReplicaLagCheckedByPerson {
  readonly checked_by: 'person';
  readonly person: string;
  readonly note: string;
}

/**
 * export.json's `replica_lag` for a rehearsal: the lag as read, held to no
 * bound. Figures in ms; null when they couldn't be read, and then
 * `unknown_reason` says why, as a run after the freeze would refuse.
 */
export interface ReplicaLagRehearsal {
  readonly checked_by: 'rehearsal';
  readonly readers: number | null;
  readonly worst_lag_ms: number | null;
  readonly worst_lag_age_ms: number | null;
  readonly read_at: string;
  readonly unknown_reason: string | null;
}

export type ReplicaLagRecord =
  | ReplicaLagCheckedByExport
  | ReplicaLagCheckedByPerson
  | ReplicaLagRehearsal;

export interface ReplicaLagReadOptions {
  /** Runs a SELECT through the export's own DB context, as its reads do. */
  readonly readRows: (sql: string) => Promise<unknown[]>;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

export interface ReplicaLagCheckOptions extends ReplicaLagReadOptions {
  /** Five minutes after the freeze: every reader must have caught up past it. */
  readonly caughtUpMs: number;
}

export interface ReplicaLagStartOptions extends ReplicaLagReadOptions {
  /**
   * Five minutes after the freeze; null for a rehearsal, which reads and
   * reports the lag but holds it to no bound.
   */
  readonly caughtUpMs: number | null;
  /** Who checked the lag instead of the export, and how; null when no one. */
  readonly checkedByPerson: ReplicaLagCheckedBy | null;
}

interface LagRow {
  readonly server_id?: unknown;
  readonly session_id?: unknown;
  readonly lag_ms?: unknown;
  readonly age_ms?: unknown;
  readonly now_ms?: unknown;
}

/** Every reader's lag as read, or why it can't be known. */
type AllReadersLag =
  | {
      readonly known: true;
      readonly readers: number;
      /** The reader furthest behind, by lag plus age. */
      readonly lagMs: number;
      readonly ageMs: number;
      readonly readMs: number;
    }
  | {
      readonly known: false;
      readonly readers: number | null;
      readonly reason: string;
      readonly readMs: number;
    };

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Each reader's newest row, as REPLICA_LAG_SQL picks one for its own reader
 * (LAST_UPDATE_TIMESTAMP DESC: the youngest age first, no timestamp last).
 */
function newestRowPerReader(rows: readonly unknown[]): LagRow[] {
  const newest = new Map<string, LagRow>();
  for (const value of rows) {
    const row = (value ?? {}) as LagRow;
    if (row.session_id === WRITER_SESSION_ID) continue;
    const reader = String(row.server_id);
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
const utcTime = (ms: number) =>
  `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const ofReaders = (count: number) =>
  count === 1 ? 'its one reader' : `its ${count} readers`;
const tableFailed = (error: unknown) =>
  `reading information_schema.replica_host_status failed (${errorCode(error)})`;

/** Reads every reader's row once; never throws for a lag it can't read. */
async function readAllReadersLag(
  options: ReplicaLagReadOptions
): Promise<AllReadersLag> {
  const localMs = (options.now ?? Date.now)();
  let rows: unknown[];
  try {
    rows = await options.readRows(ALL_READERS_LAG_SQL);
  } catch (error) {
    // The message can name the user and host: the log only, never export.json.
    options.log(
      `replica lag not read: ${String((error as Error)?.message ?? error)}`
    );
    return {
      known: false,
      readers: null,
      reason: tableFailed(error),
      readMs: localMs
    };
  }
  const readers = newestRowPerReader(rows);
  const unknown = (reason: string): AllReadersLag => ({
    known: false,
    readers: readers.length,
    reason,
    readMs: localMs
  });
  if (!readers.length) {
    return unknown(
      'information_schema.replica_host_status has no row for any reader'
    );
  }
  const readings: { lagMs: number; ageMs: number }[] = [];
  for (const row of readers) {
    const { lagMs, ageMs, unknown: why, error } = await readRow(row);
    if (why || lagMs === null || ageMs === null) {
      return unknown(
        `the row of one of ${ofReaders(readers.length)} says ${error}`
      );
    }
    readings.push({ lagMs, ageMs });
  }
  const worst = readings.reduce((a, b) =>
    b.lagMs + b.ageMs > a.lagMs + a.ageMs ? b : a
  );
  const serverMs = numberOrNull(readers[0].now_ms);
  if (serverMs === null || serverMs <= 0) {
    return unknown("the server's clock could not be read");
  }
  return {
    known: true,
    readers: readers.length,
    lagMs: worst.lagMs,
    ageMs: worst.ageMs,
    readMs: Math.min(localMs, serverMs)
  };
}

/** How a person who checked the lag another way runs the export. */
function personCheck(caughtUpMs: number): string {
  return (
    `read the largest lag over all readers another way (on Aurora, the ` +
    `AuroraReplicaLagMaximum metric) and, once that much time has passed ` +
    `since ${utcTime(caughtUpMs)}, run the export again with ` +
    `--replica-lag-checked-by <your name> --replica-lag-check-note <how you checked it>`
  );
}

/**
 * The largest lag over every reader, plus the age of its row and the chain
 * exports' margin for a row's timestamp (REPLICA_LAG_AGE_MARGIN_MS), must be
 * less than the time since `caughtUpMs`: a reader at most that far behind
 * has every write that committed before it. Throws a refusal that says why
 * and when to try again; never passes an unknown lag.
 */
export async function checkReplicaLag(
  options: ReplicaLagCheckOptions
): Promise<ReplicaLagCheckedByExport> {
  const { caughtUpMs } = options;
  const lag = await readAllReadersLag(options);
  if (!lag.known) {
    throw new WavesExportUsageError(
      `The export can't tell how far the read replica is behind: ${lag.reason}. ` +
        `It needs every reader caught up past ${utcTime(caughtUpMs)}, five ` +
        `minutes after the freeze. If you can, ${personCheck(caughtUpMs)}.`,
      { showHelp: false }
    );
  }
  const behindMs = lag.lagMs + lag.ageMs + REPLICA_LAG_AGE_MARGIN_MS;
  if (behindMs >= lag.readMs - caughtUpMs) {
    const retryMs = Math.ceil((caughtUpMs + behindMs) / 1000) * 1000;
    throw new WavesExportUsageError(
      `The read replica may be up to ${seconds(behindMs)} behind: the largest ` +
        `lag over ${ofReaders(lag.readers)} is ${seconds(lag.lagMs)}, ` +
        `in a reading ${seconds(lag.ageMs)} old, plus ` +
        `${seconds(REPLICA_LAG_AGE_MARGIN_MS)} for clock and timestamp ` +
        `rounding. The export needs every reader caught up past ` +
        `${utcTime(caughtUpMs)}, five minutes after the freeze. ` +
        `Try again after ${utcTime(retryMs)}.` +
        (lag.ageMs >= STALE_READING_MS
          ? ` If that reading is older still then, the reader has stopped ` +
            `updating it: ${personCheck(caughtUpMs)}.`
          : ''),
      { showHelp: false }
    );
  }
  return {
    checked_by: 'export',
    readers: lag.readers,
    worst_lag_ms: Math.ceil(lag.lagMs),
    worst_lag_age_ms: Math.ceil(lag.ageMs),
    read_at: new Date(lag.readMs).toISOString()
  };
}

/**
 * A rehearsal's reading: the same query and rules, logged and recorded,
 * never a refusal. Nothing it meets is fatal, so the rehearsal before the
 * freeze shows whether the query works on the live readers.
 */
async function rehearseReplicaLag(
  options: ReplicaLagReadOptions
): Promise<ReplicaLagRehearsal> {
  let lag: AllReadersLag;
  try {
    lag = await readAllReadersLag(options);
  } catch (error) {
    options.log(
      `replica lag not read: ${String((error as Error)?.message ?? error)}`
    );
    lag = {
      known: false,
      readers: null,
      reason: tableFailed(error),
      readMs: (options.now ?? Date.now)()
    };
  }
  if (!lag.known) {
    options.log(
      `rehearsal: the read replica's lag can't be read: ${lag.reason}. A run ` +
        `after the freeze would refuse on this.`
    );
    return {
      checked_by: 'rehearsal',
      readers: lag.readers,
      worst_lag_ms: null,
      worst_lag_age_ms: null,
      read_at: new Date(lag.readMs).toISOString(),
      unknown_reason: lag.reason
    };
  }
  const record: ReplicaLagRehearsal = {
    checked_by: 'rehearsal',
    readers: lag.readers,
    worst_lag_ms: Math.ceil(lag.lagMs),
    worst_lag_age_ms: Math.ceil(lag.ageMs),
    read_at: new Date(lag.readMs).toISOString(),
    unknown_reason: null
  };
  options.log(
    `rehearsal: the largest lag over ${ofReaders(lag.readers)} is ` +
      `${record.worst_lag_ms} ms, in a reading ${record.worst_lag_age_ms} ms ` +
      `old (a rehearsal holds it to no bound)`
  );
  return record;
}

/**
 * export.json's `replica_lag`, settled before any stage reads: a rehearsal's
 * reading, which never refuses; who checked it and how with
 * --replica-lag-checked-by, said loudly; otherwise the export's own reading,
 * or a refusal (checkReplicaLag).
 */
export async function replicaLagAtStart(
  options: ReplicaLagStartOptions
): Promise<ReplicaLagRecord> {
  const { caughtUpMs, checkedByPerson, ...read } = options;
  if (caughtUpMs === null) {
    return rehearseReplicaLag(read);
  }
  if (checkedByPerson) {
    const { person, note } = checkedByPerson;
    options.log(
      `WARNING: the export does not check the read replica's lag. It takes ` +
        `the word of ${JSON.stringify(person)} that every reader has caught ` +
        `up past ${utcTime(caughtUpMs)}, checked this way: ` +
        `${JSON.stringify(note)}. export.json records both.`
    );
    return { checked_by: 'person', person, note };
  }
  const checked = await checkReplicaLag({ ...read, caughtUpMs });
  options.log(
    `read replica: the largest lag over ${ofReaders(checked.readers)} is ` +
      `${checked.worst_lag_ms} ms, in a reading ${checked.worst_lag_age_ms} ms ` +
      `old; every reader has caught up past ${utcTime(caughtUpMs)}`
  );
  return checked;
}
