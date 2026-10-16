import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  DELETED_DROPS_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_MIGRATION_AUDIT_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { competitionEntryVisibleSql } from './competition-entry-visibility';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';

export interface CompetitionVoteActivity {
  readonly sequence: number | string;
  readonly drop_id: string;
  readonly voter_profile_id: string;
  readonly submitter_id: string | null;
  readonly previous_value: number | string;
  readonly value: number | string;
  readonly occurred_at: number | string;
  readonly legacy_id?: string | null;
  readonly legacy_contents?: string | null;
  readonly proxy_id?: string | null;
}

export class CompetitionVoteActivityRepository extends LazyDbAccessCompatibleService {
  public async hasExactLineage(
    competitionId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const timerName = `${this.constructor.name}->hasExactLineage`;
    try {
      ctx.timer?.start(timerName);
      const [row] = await this.db.execute<{
        cutovers: number;
        unqualified: number;
      }>(
        `SELECT COUNT(*) AS cutovers,
          COALESCE(SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(report, '$.voteActivityIdentity')) = 'NATIVE_ID_V1'
            THEN 0 ELSE 1 END), 0) AS unqualified
        FROM ${COMPETITION_MIGRATION_AUDIT_TABLE}
        WHERE competition_id = :competitionId AND action = 'CUTOVER'`,
        { competitionId },
        { wrappedConnection: ctx.connection }
      );
      return Number(row.cutovers) > 0 && Number(row.unqualified) === 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async listTransferred(
    competitionId: string,
    waveId: string,
    transferredAt: number | null,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<CompetitionVoteActivity[]> {
    // A null cutoff is reserved for primaries whose every cutover certifies
    // exact native log identities. Older cutovers retain their existing cutoff.
    // Deduplicate by identity before paging, including hidden native entries.
    // While legacy-owned, re-migration can reset shadow entries: an exact linked
    // log and a live legacy drop retain that accepted history's identity.
    // Each source contributes offset+limit rows before the final global page.
    const timerName = `${this.constructor.name}->listTransferred`;
    try {
      ctx.timer?.start(timerName);
      return await this.db.execute<CompetitionVoteActivity>(
        `SELECT activity.* FROM (
        (SELECT 1 AS source_order, history.sequence, COALESCE(entry.drop_id, native_log.target_id) AS drop_id, history.voter_profile_id,
          COALESCE(entry.submitter_id, native_log.additional_data_1) AS submitter_id, history.previous_value, history.value,
          history.occurred_at, NULL AS legacy_id, CAST(native_log.contents AS CHAR) AS legacy_contents,
          native_log.proxy_id
        FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
        LEFT JOIN ${COMPETITION_ENTRIES_TABLE} entry
          ON entry.competition_id = history.competition_id AND entry.id = history.entry_id
        LEFT JOIN ${PROFILES_ACTIVITY_LOGS_TABLE} native_log
          ON native_log.id = CONCAT(history.competition_id, ':', history.sequence)
          AND native_log.additional_data_2 = :waveId AND native_log.type = :logType
        WHERE history.competition_id = :competitionId AND (
          ${competitionEntryVisibleSql('entry')}
          OR (entry.id IS NULL AND native_log.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM ${COMPETITIONS_TABLE} owner JOIN ${DROPS_TABLE} source_drop
              ON source_drop.wave_id = owner.wave_id AND source_drop.id = native_log.target_id
            WHERE owner.id = :competitionId AND owner.legacy_wave_id = :waveId
              AND owner.storage_mode = 'LEGACY_ADAPTER'
              AND source_drop.drop_type IN ('PARTICIPATORY', 'WINNER')
              AND NOT EXISTS (SELECT 1 FROM ${DELETED_DROPS_TABLE} deleted WHERE deleted.id = source_drop.id)
          ))
        )
        ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT :candidateLimit)
        UNION ALL
        (SELECT 0 AS source_order, 0 AS sequence, log.target_id AS drop_id,
          log.profile_id AS voter_profile_id, log.additional_data_1 AS submitter_id,
          0 AS previous_value, 0 AS value,
          TIMESTAMPDIFF(MICROSECOND, '1970-01-01', log.created_at) / 1000 AS occurred_at,
          log.id AS legacy_id, CAST(log.contents AS CHAR) AS legacy_contents,
          log.proxy_id
        FROM ${PROFILES_ACTIVITY_LOGS_TABLE} log
        WHERE log.additional_data_2 = :waveId AND log.type = :logType
          AND NOT EXISTS (
            SELECT 1 FROM ${COMPETITION_VOTE_HISTORY_TABLE} linked
            WHERE linked.sequence = CAST(SUBSTRING(log.id, LENGTH(:competitionId) + 2) AS UNSIGNED)
              AND linked.competition_id = :competitionId
              AND log.id = CONCAT(linked.competition_id, ':', linked.sequence)
          )
          AND (:transferredAtUtc IS NULL OR log.created_at <= :transferredAtUtc)
        ORDER BY log.created_at DESC, log.id DESC LIMIT :candidateLimit)
      ) activity
      ORDER BY activity.occurred_at DESC, activity.source_order DESC,
        activity.sequence DESC, activity.legacy_id DESC
      LIMIT :offset, :limit`,
        {
          competitionId,
          waveId,
          transferredAtUtc:
            transferredAt === null
              ? null
              : new Date(transferredAt)
                  .toISOString()
                  .slice(0, 23)
                  .replace('T', ' '),
          logType: ProfileActivityLogType.DROP_VOTE_EDIT,
          candidateLimit: offset + limit,
          offset,
          limit
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async list(
    competitionId: string,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<CompetitionVoteActivity[]> {
    return this.db.execute<CompetitionVoteActivity>(
      `SELECT history.*, entry.drop_id, entry.submitter_id
       FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
       JOIN ${COMPETITION_ENTRIES_TABLE} entry ON entry.competition_id = history.competition_id AND entry.id = history.entry_id
       WHERE history.competition_id = :competitionId AND ${competitionEntryVisibleSql('entry')}
       ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT :offset, :limit`,
      { competitionId, offset, limit },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const competitionVoteActivityRepository =
  new CompetitionVoteActivityRepository(dbSupplier);
