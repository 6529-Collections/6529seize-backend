import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILE_LATEST_LOG_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';

/** The log identity is also the public native Activity identity. This exact link
 * avoids matching distinct replacements by value or second-precision timestamps.
 * Only the immutable legacy primary can write wave-scoped compatibility logs. */
export async function recordNativePrimaryVoteActivity(
  db: SqlExecutor,
  params: {
    competitionId: string;
    entryId: string;
    voterProfileId: string;
    previousVote: number;
    value: number;
    occurredAt: number;
    proxyId?: string | null;
    reason?: string;
  },
  sequence: number,
  ctx: RequestContext
): Promise<void> {
  const timerName = 'recordNativePrimaryVoteActivity';
  if (!ctx.connection) {
    throw new Error('Native vote Activity requires a transaction');
  }
  ctx.timer?.start(timerName);
  try {
    const inserted = await db.execute(
      `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE}
       (id, profile_id, target_id, contents, type, proxy_id, created_at, additional_data_1, additional_data_2, competition_id)
       SELECT :activityId, :voterProfileId, e.drop_id, :contents, 'DROP_VOTE_EDIT', :proxyId,
         DATE_ADD('1970-01-01', INTERVAL :occurredAt MICROSECOND), e.submitter_id, c.wave_id, c.id
       FROM ${COMPETITIONS_TABLE} c JOIN ${COMPETITION_ENTRIES_TABLE} e
         ON e.competition_id = c.id AND e.id = :entryId
       WHERE c.id = :competitionId AND c.legacy_wave_id = c.wave_id`,
      {
        ...params,
        occurredAt: params.occurredAt * 1000,
        activityId: `${params.competitionId}:${sequence}`,
        proxyId: params.proxyId ?? null,
        contents: JSON.stringify({
          oldVote: params.previousVote,
          newVote: params.value,
          ...(params.reason ? { reason: params.reason } : {})
        })
      },
      { wrappedConnection: ctx.connection }
    );
    if (db.getAffectedRows(inserted) !== 1) {
      throw new Error('Native primary vote requires exactly one Activity log');
    }
    await db.execute(
      `INSERT INTO ${PROFILE_LATEST_LOG_TABLE} (profile_id, latest_activity)
         VALUES (:voterProfileId, DATE_ADD('1970-01-01', INTERVAL :occurredAt MICROSECOND))
         ON DUPLICATE KEY UPDATE latest_activity = GREATEST(latest_activity, VALUES(latest_activity))`,
      {
        voterProfileId: params.voterProfileId,
        occurredAt: params.occurredAt * 1000
      },
      { wrappedConnection: ctx.connection }
    );
  } finally {
    ctx.timer?.stop(timerName);
  }
}
