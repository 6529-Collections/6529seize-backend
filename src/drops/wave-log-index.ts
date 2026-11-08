import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { SqlExecutor } from '@/sql-executor';

/** (additional_data_2, type, created_at): a wave's logs of one type, in order. */
export const WAVE_LOG_INDEX = 'idx_pal_wave_type_created_at';
const RECHECK_MISSING_MS = 5 * 60_000;
/** A failed check is retried sooner than a genuinely missing index. */
const RECHECK_FAILED_MS = 30_000;

let known:
  | { readonly present: boolean; readonly at: number; readonly failed: boolean }
  | undefined;
let checking: Promise<boolean> | undefined;

/**
 * Whether the wave log index exists. It is built by an operator-run schema
 * step, so a present index is remembered for the container's life and a
 * missing one is checked again every few minutes.
 */
export function waveLogIndexReady(
  db: SqlExecutor,
  now: number = Date.now()
): Promise<boolean> {
  if (
    known &&
    (known.present ||
      now - known.at < (known.failed ? RECHECK_FAILED_MS : RECHECK_MISSING_MS))
  )
    return Promise.resolve(known.present);
  checking ??= db
    .execute<{ found: number }>(
      `select 1 as found from information_schema.statistics
       where table_schema = database() and table_name = :table
         and index_name = :index limit 1`,
      { table: PROFILES_ACTIVITY_LOGS_TABLE, index: WAVE_LOG_INDEX }
    )
    .then(
      (rows) => ({ present: rows.length > 0, failed: false }),
      () => ({ present: false, failed: true })
    )
    .then(({ present, failed }) => {
      known = { present, at: now, failed };
      checking = undefined;
      return present;
    });
  return checking;
}

/** Test seam: forget the check, or pin its result. */
export function resetWaveLogIndexReady(present?: boolean): void {
  known =
    present === undefined
      ? undefined
      : { present, at: Date.now(), failed: false };
  checking = undefined;
}
