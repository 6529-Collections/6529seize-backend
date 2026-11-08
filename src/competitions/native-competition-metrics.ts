import { Logger } from '@/logging';

const NAMESPACE = '6529/NativeCompetitions';
const logger = Logger.get('NATIVE_COMPETITION_METRICS');

/**
 * Which way one competition's loop run went:
 * - `static`: an undue static Rank; transitions only (waves #2380);
 * - `off_lock`: an undue time-locked Rank; credit under the lock, the
 *   leaderboard computed off it (waves #2381);
 * - `off_lock_fallback`: `off_lock` whose inputs changed, followed by the
 *   locked run;
 * - `locked`: the full locked run (decisions due, Approve, static boards in
 *   the snapshotter, or any run inside a caller's transaction).
 */
export type NativeCompetitionRunPath =
  | 'static'
  | 'off_lock'
  | 'off_lock_fallback'
  | 'locked';

export interface NativeCompetitionRunRecord {
  readonly competitionId: string;
  readonly operation: 'decisions' | 'leaderboard';
  readonly path: NativeCompetitionRunPath;
  /** Every millisecond this run held the competition row, all transactions. */
  readonly lockedMs: number;
  /** Leaderboard computation off the lock; 0 when there was none. */
  readonly computeMs: number;
  readonly durationMs: number;
}

/**
 * One EMF line per competition per loop run (an unprefixed JSON log line; no
 * CloudWatch API call or IAM change). Dimensions stay low-cardinality
 * (operation, path); `competition_id` is a property, so Logs Insights can sum
 * one competition's row-lock duty:
 *   filter _type = "6529.native_competition_run.v1"
 *   | stats sum(LockedMs)/1000 as locked_s by competition_id, operation
 */
export function recordNativeCompetitionRun(
  record: NativeCompetitionRunRecord
): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        _type: '6529.native_competition_run.v1',
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: NAMESPACE,
              Dimensions: [['Operation', 'Path'], ['Operation']],
              Metrics: [
                { Name: 'LockedMs', Unit: 'Milliseconds' },
                { Name: 'ComputeMs', Unit: 'Milliseconds' },
                { Name: 'DurationMs', Unit: 'Milliseconds' },
                { Name: 'Runs', Unit: 'Count' }
              ]
            }
          ]
        },
        Operation: record.operation,
        Path: record.path,
        competition_id: record.competitionId,
        LockedMs: record.lockedMs,
        ComputeMs: record.computeMs,
        DurationMs: record.durationMs,
        Runs: 1
      })}\n`
    );
  } catch {
    // Telemetry must never change a competition run.
    logger.error('Native competition run metric could not be emitted');
  }
}
