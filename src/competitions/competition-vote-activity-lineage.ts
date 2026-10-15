import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { SqlExecutor } from '@/sql-executor';

/** Legacy log DATETIMEs have second precision. Capture the IDs already committed
 * in the ownership transition's second while holding the primary ownership lock.
 * Comparing timestamps alone cannot classify votes accepted in that same second. */
export async function voteActivityBoundary(
  db: SqlExecutor,
  waveId: string,
  now: number,
  ctx: RequestContext
): Promise<{ at: number; ids: string[] }> {
  const timerName = 'voteActivityBoundary';
  ctx.timer?.start(timerName);
  try {
    const start = new Date(Math.floor(now / 1000) * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const rows = await db.execute<{ id: string }>(
      `SELECT id FROM ${PROFILES_ACTIVITY_LOGS_TABLE}
       WHERE additional_data_2 = :waveId AND type = 'DROP_VOTE_EDIT'
         AND created_at >= :start
       ORDER BY id`,
      { waveId, start },
      { wrappedConnection: ctx.connection }
    );
    return { at: now, ids: rows.map((row) => row.id) };
  } finally {
    ctx.timer?.stop(timerName);
  }
}
