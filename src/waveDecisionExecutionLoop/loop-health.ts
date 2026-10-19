import { appFeatures } from '@/app-features';
import {
  COMPETITIONS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';

/** Read persisted due work, including leased/backed-off publication. A resolved
 * handler, or one successful decision, cannot clear another outstanding item. */
export async function observeDecisionBacklogs(): Promise<void> {
  const now = Date.now();
  try {
    const rows = await readLoopHealthRows<{ oldest: number | string | null }>(
      `select min(due_at) as oldest from (
        select w.next_decision_time as due_at from ${WAVES_TABLE} w
        left join ${COMPETITIONS_TABLE} c on c.legacy_wave_id = w.id
        where w.next_decision_time is not null
          and (c.id is null or (c.storage_mode = 'LEGACY_ADAPTER' and c.execution_mode = 'ACTIVE'))
        union all
        select cast(nullif(json_unquote(json_extract(decision_config, '$.next_decision_time')), 'null') as unsigned) as due_at
        from ${COMPETITIONS_TABLE} where storage_mode = 'NATIVE' and execution_mode = 'ACTIVE'
          and lifecycle = 'PUBLISHED' and type = 'RANK' and :nativeEnabled = 1
          and nullif(json_unquote(json_extract(decision_config, '$.next_decision_time')), 'null') is not null
      ) due`,
      {
        now,
        nativeEnabled: appFeatures.isNativeCompetitionExecutionEnabled() ? 1 : 0
      }
    );
    publish('decisions', rows[0]?.oldest, now, 300);
  } catch {
    // Missing business observations remain unknown in the independent monitor.
  }
  try {
    const rows = await readLoopHealthRows<{ oldest: number | string | null }>(
      `select min(created_at) as oldest from (
        select created_at from ${COMPETITION_OUTBOX_TABLE} where delivered_at is null
        union all
        select created_at from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where completed_at is null
      ) pending`
    );
    publish('publication', rows[0]?.oldest, now);
  } catch {
    // Telemetry failure cannot replace a decision/publication failure.
  }
}

function publish(
  operation: 'decisions' | 'publication',
  oldest: number | string | null | undefined,
  now: number,
  deadlineSeconds?: number
): void {
  // A missing/malformed query result is unknown, never an empty backlog.
  if (oldest === undefined) return;
  const oldestPendingAt =
    oldest === null ? undefined : Math.floor(Number(oldest) / 1000);
  if (
    oldestPendingAt !== undefined &&
    (!Number.isSafeInteger(oldestPendingAt) || oldestPendingAt <= 0)
  )
    return;
  const pending =
    oldestPendingAt !== undefined &&
    (operation === 'publication' || oldestPendingAt <= now / 1000);
  reportLoopHealth({
    operation,
    pending,
    ...(pending ? { oldestPendingAt } : {}),
    ...(deadlineSeconds && oldestPendingAt
      ? { nextDueAt: oldestPendingAt }
      : {}),
    recovery: 'automatic',
    ...(!pending ? { progressAt: Math.floor(now / 1000) } : {}),
    ...(deadlineSeconds && oldestPendingAt
      ? { deadlineAt: oldestPendingAt + deadlineSeconds }
      : {})
  });
}
