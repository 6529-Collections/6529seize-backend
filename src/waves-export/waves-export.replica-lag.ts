import {
  errorCode,
  readReplicaLag,
  REPLICA_LAG_AGE_MARGIN_MS,
  ReplicaLagReading
} from '@/dbDumpsDaily/chain-exports/replica-snapshot';
import { WavesExportUsageError } from './cli-options';

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

/** export.json's `replica_lag` with --replica-lag-checked. */
export interface ReplicaLagCheckedByPerson {
  readonly checked_by: 'person';
}

export type ReplicaLagRecord =
  | ReplicaLagCheckedByExport
  | ReplicaLagCheckedByPerson;

export interface ReplicaLagCheckOptions {
  /** Five minutes after the freeze: every reader must have caught up past it. */
  readonly caughtUpMs: number;
  /** Runs a SELECT through the export's own DB context, as its reads do. */
  readonly readRows: (sql: string) => Promise<unknown[]>;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

export interface ReplicaLagStartOptions extends Omit<
  ReplicaLagCheckOptions,
  'caughtUpMs'
> {
  /** Null for a rehearsal, which checks neither the time nor the lag. */
  readonly caughtUpMs: number | null;
  /** --replica-lag-checked: a person read the lag, the export doesn't. */
  readonly checkedByPerson: boolean;
}

interface LagRow {
  readonly server_id?: unknown;
  readonly session_id?: unknown;
  readonly lag_ms?: unknown;
  readonly age_ms?: unknown;
  readonly now_ms?: unknown;
}

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

function unknownLag(reason: string, caughtUpMs: number): WavesExportUsageError {
  const since = utcTime(caughtUpMs);
  return new WavesExportUsageError(
    `The export can't tell how far the read replica is behind: ${reason}. ` +
      `It needs every reader caught up past ${since}, five minutes after the freeze. ` +
      `If you read the largest lag over all readers another way (on Aurora, ` +
      `the AuroraReplicaLagMaximum metric), run the export again with ` +
      `--replica-lag-checked once that much time has passed since ${since}.`,
    { showHelp: false }
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
  const localMs = (options.now ?? Date.now)();
  let rows: unknown[];
  try {
    rows = await options.readRows(ALL_READERS_LAG_SQL);
  } catch (error) {
    // The message can name the user and host: the log only, never export.json.
    options.log(
      `replica lag not read: ${String((error as Error)?.message ?? error)}`
    );
    throw unknownLag(
      `reading information_schema.replica_host_status failed (${errorCode(error)})`,
      caughtUpMs
    );
  }
  const readers = newestRowPerReader(rows);
  if (!readers.length) {
    throw unknownLag(
      'information_schema.replica_host_status has no row for any reader',
      caughtUpMs
    );
  }
  const readings: { lagMs: number; ageMs: number }[] = [];
  for (const row of readers) {
    const { lagMs, ageMs, unknown, error } = await readRow(row);
    if (unknown || lagMs === null || ageMs === null) {
      throw unknownLag(
        `the row of one of ${ofReaders(readers.length)} says ${error}`,
        caughtUpMs
      );
    }
    readings.push({ lagMs, ageMs });
  }
  const worst = readings.reduce((a, b) =>
    b.lagMs + b.ageMs > a.lagMs + a.ageMs ? b : a
  );
  const serverMs = numberOrNull(readers[0].now_ms);
  if (serverMs === null || serverMs <= 0) {
    throw unknownLag("the server's clock could not be read", caughtUpMs);
  }
  const readMs = Math.min(localMs, serverMs);
  const behindMs = worst.lagMs + worst.ageMs + REPLICA_LAG_AGE_MARGIN_MS;
  if (behindMs >= readMs - caughtUpMs) {
    const retryMs = Math.ceil((caughtUpMs + behindMs) / 1000) * 1000;
    throw new WavesExportUsageError(
      `The read replica may be up to ${seconds(behindMs)} behind: the largest ` +
        `lag over ${ofReaders(readers.length)} is ${seconds(worst.lagMs)}, ` +
        `in a reading ${seconds(worst.ageMs)} old, plus ` +
        `${seconds(REPLICA_LAG_AGE_MARGIN_MS)} for clock and timestamp ` +
        `rounding. The export needs every reader caught up past ` +
        `${utcTime(caughtUpMs)}, five minutes after the freeze. ` +
        `Try again after ${utcTime(retryMs)}.` +
        (worst.ageMs >= STALE_READING_MS
          ? ` If that reading is older still then, the reader has stopped ` +
            `updating it: read the largest lag over all readers another way ` +
            `and run with --replica-lag-checked once that much time has ` +
            `passed since ${utcTime(caughtUpMs)}.`
          : ''),
      { showHelp: false }
    );
  }
  return {
    checked_by: 'export',
    readers: readers.length,
    worst_lag_ms: Math.ceil(worst.lagMs),
    worst_lag_age_ms: Math.ceil(worst.ageMs),
    read_at: new Date(readMs).toISOString()
  };
}

/**
 * export.json's `replica_lag`, settled before any stage reads: null for a
 * rehearsal; `checked_by: "person"` with --replica-lag-checked, said loudly;
 * otherwise the export's own reading, or a refusal (checkReplicaLag).
 */
export async function replicaLagAtStart(
  options: ReplicaLagStartOptions
): Promise<ReplicaLagRecord | null> {
  const { caughtUpMs, checkedByPerson, ...check } = options;
  if (caughtUpMs === null) {
    return null;
  }
  if (checkedByPerson) {
    options.log(
      `WARNING: --replica-lag-checked: the export does not check the read ` +
        `replica's lag. It takes your word that every reader has caught up ` +
        `past ${utcTime(caughtUpMs)}, and export.json records ` +
        `replica_lag.checked_by "person".`
    );
    return { checked_by: 'person' };
  }
  const checked = await checkReplicaLag({ ...check, caughtUpMs });
  options.log(
    `read replica: the largest lag over ${ofReaders(checked.readers)} is ` +
      `${checked.worst_lag_ms} ms, in a reading ${checked.worst_lag_age_ms} ms ` +
      `old; every reader has caught up past ${utcTime(caughtUpMs)}`
  );
  return checked;
}
