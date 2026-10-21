import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { competitionEntryVisibleSql } from './competition-entry-visibility';
import { pageCompetitionVoteActivity } from './competition-vote-activity-time';
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
  readonly occurred_at: number | string | null;
  readonly legacy_id?: string | null;
  readonly legacy_created_at?: Date | string | null;
  readonly legacy_contents?: string | null;
  readonly proxy_id?: string | null;
}

export class CompetitionVoteActivityRepository extends LazyDbAccessCompatibleService {
  public async list(
    competitionId: string,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<CompetitionVoteActivity[]> {
    const timerName = `${this.constructor.name}->list`;
    try {
      ctx.timer?.start(timerName);
      // Both retained shared activity and native activity have permanent source
      // identities. Exclude exact linked IDs before pagination, even when a
      // native entry is hidden; equal values/timestamps never imply a duplicate.
      const candidates = await this.db.execute<CompetitionVoteActivity>(
        `SELECT activity.* FROM (
        (SELECT 1 AS source_order, history.sequence, COALESCE(entry.drop_id,history.drop_id,native_log.target_id) AS drop_id,
          history.voter_profile_id, COALESCE(entry.submitter_id,history.submitter_id,native_log.additional_data_1) AS submitter_id,
          history.previous_value, history.value, history.occurred_at,
          NULL AS legacy_id, NULL AS legacy_created_at,
          CAST(COALESCE(native_log.contents, history.contents) AS CHAR) AS legacy_contents,
          COALESCE(native_log.proxy_id, history.proxy_id) AS proxy_id
        FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
        LEFT JOIN ${COMPETITIONS_TABLE} owner ON owner.id=history.competition_id
        LEFT JOIN ${COMPETITION_ENTRIES_TABLE} entry
          ON entry.competition_id = history.competition_id AND entry.id = history.entry_id
        LEFT JOIN ${PROFILES_ACTIVITY_LOGS_TABLE} native_log
          ON native_log.id = CONCAT(history.competition_id, ':', history.sequence)
          AND native_log.type = :logType AND native_log.additional_data_2=COALESCE(entry.wave_id,owner.wave_id)
        WHERE history.competition_id = :competitionId AND (${competitionEntryVisibleSql('entry')}
          OR (entry.id IS NULL AND COALESCE(history.drop_id,native_log.target_id) IS NOT NULL))
        ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT :candidateLimit)
        UNION ALL
        (SELECT 0 AS source_order, 0 AS sequence, log.target_id AS drop_id,
          log.profile_id AS voter_profile_id, log.additional_data_1 AS submitter_id,
          0 AS previous_value, 0 AS value,
          0 AS occurred_at,
          log.id AS legacy_id, log.created_at AS legacy_created_at, CAST(log.contents AS CHAR) AS legacy_contents, log.proxy_id
        FROM ${PROFILES_ACTIVITY_LOGS_TABLE} log
        WHERE log.competition_id = :competitionId AND log.type = :logType
          AND NOT EXISTS (
            SELECT 1 FROM ${COMPETITION_VOTE_HISTORY_TABLE} linked
            WHERE linked.competition_id = :competitionId
              AND log.id = CONCAT(linked.competition_id, ':', linked.sequence)
          )
        ORDER BY log.created_at DESC, log.id DESC LIMIT :candidateLimit)
      ) activity
      ORDER BY activity.source_order DESC, activity.sequence DESC, activity.legacy_id DESC`,
        {
          competitionId,
          logType: ProfileActivityLogType.DROP_VOTE_EDIT,
          candidateLimit: offset + limit
        },
        { wrappedConnection: ctx.connection }
      );
      return pageCompetitionVoteActivity(candidates, offset, limit);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const competitionVoteActivityRepository =
  new CompetitionVoteActivityRepository(dbSupplier);
