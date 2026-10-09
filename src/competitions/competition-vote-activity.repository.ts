import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
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
  public async listTransferred(
    competitionId: string,
    waveId: string,
    transferredAt: number,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<CompetitionVoteActivity[]> {
    // Keep the original log IDs, JSON and proxy attribution. Historical wave
    // logs belong only to the transferred legacy primary, never its siblings.
    // Apply pagination once, after combining both histories chronologically.
    return this.db.execute<CompetitionVoteActivity>(
      `SELECT activity.* FROM (
        (SELECT history.sequence, entry.drop_id, history.voter_profile_id,
          entry.submitter_id, history.previous_value, history.value,
          history.occurred_at, NULL AS legacy_id, NULL AS legacy_contents,
          NULL AS proxy_id
        FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
        JOIN ${COMPETITION_ENTRIES_TABLE} entry
          ON entry.competition_id = history.competition_id AND entry.id = history.entry_id
        WHERE history.competition_id = :competitionId AND ${competitionEntryVisibleSql('entry')}
        ORDER BY history.occurred_at DESC, history.sequence DESC LIMIT :candidateLimit)
        UNION ALL
        (SELECT 0 AS sequence, log.target_id AS drop_id,
          log.profile_id AS voter_profile_id, log.additional_data_1 AS submitter_id,
          0 AS previous_value, 0 AS value,
          TIMESTAMPDIFF(MICROSECOND, '1970-01-01', log.created_at) / 1000 AS occurred_at,
          log.id AS legacy_id, CAST(log.contents AS CHAR) AS legacy_contents,
          log.proxy_id
        FROM ${PROFILES_ACTIVITY_LOGS_TABLE} log
        WHERE log.additional_data_2 = :waveId AND log.type = :logType
          AND log.created_at <= FROM_UNIXTIME(:transferredAt / 1000)
        ORDER BY log.created_at DESC, log.id DESC LIMIT :candidateLimit)
      ) activity
      ORDER BY activity.occurred_at DESC, activity.sequence DESC, activity.legacy_id DESC
      LIMIT :offset, :limit`,
      {
        competitionId,
        waveId,
        transferredAt,
        logType: ProfileActivityLogType.DROP_VOTE_EDIT,
        candidateLimit: offset + limit,
        offset,
        limit
      },
      { wrappedConnection: ctx.connection }
    );
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
