import { competitionEntryVisibleSql } from '@/competitions/competition-entry-visibility';
import { randomUUID } from 'node:crypto';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE
} from '@/constants';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { CompetitionRoutingRecord } from './competition.types';
import { NativeDecisionAward } from './native-competition-runtime.repository';

export type CompetitionMyVotesSort =
  | 'vote_amount'
  | 'leaderboard'
  | 'last_voted';

export type CompetitionMyVote = {
  entry_id: string;
  drop_id: string;
  value: number;
  credit_spent: number;
  entry_status: CompetitionEntryStatus;
};

export class CompetitionInteractionRepository extends LazyDbAccessCompatibleService {
  private async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${operation}`;
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(name);
    }
  }

  public async setVote(
    competitionId: string,
    entryId: string,
    profileId: string,
    value: number,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Native voting requires a transaction');
    await this.query(
      'setVote',
      `INSERT INTO ${COMPETITION_VOTES_TABLE}
      (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at)
      VALUES (:id,:competitionId,:entryId,:profileId,:value,ABS(:value),:now,:now)
      ON DUPLICATE KEY UPDATE value=:value, credit_spent=ABS(:value), updated_at=:now`,
      { id: randomUUID(), competitionId, entryId, profileId, value, now },
      ctx
    );
  }

  public async myVotes(
    record: CompetitionRoutingRecord,
    profileId: string,
    offset: number,
    limit: number,
    ctx: RequestContext,
    sort: CompetitionMyVotesSort = 'vote_amount'
  ): Promise<CompetitionMyVote[]> {
    let joins = '';
    let order = 'v.value DESC,v.updated_at ASC,e.drop_id ASC';
    if (sort === 'leaderboard') {
      joins = `LEFT JOIN ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} lb
        ON lb.competition_id=v.competition_id AND lb.entry_id=v.entry_id`;
      order = `lb.\`rank\` IS NULL ASC,lb.\`rank\` ASC,${record.legacy_wave_id === null ? 'COALESCE(lb.entry_id,e.id)' : 'COALESCE(lb.drop_id,e.drop_id)'} ASC`;
    } else if (sort === 'last_voted') {
      // Allocation updated_at also changes on automatic credit reconciliation and
      // no-op commands. Only confirmed user changes establish voting recency.
      // Retained primary logs supply pre-migration history. Exclude linked
      // native projections: their DATETIME rounding must not replace exact
      // native milliseconds. Unknown timestamps remain null, last.
      joins = `LEFT JOIN (
        SELECT activity.drop_id,MAX(activity.occurred_at) AS last_voted_at FROM (
          SELECT entry.drop_id,h.occurred_at FROM ${COMPETITION_VOTE_HISTORY_TABLE} h
          JOIN ${COMPETITION_ENTRIES_TABLE} entry ON entry.id=h.entry_id AND entry.competition_id=h.competition_id
          WHERE h.competition_id=:competitionId AND h.voter_profile_id=:profileId
            AND h.value<>h.previous_value AND JSON_EXTRACT(h.contents,'$.reason') IS NULL
          UNION ALL
          SELECT log.target_id,TIMESTAMPDIFF(MICROSECOND,'1970-01-01',log.created_at) DIV 1000
          FROM ${PROFILES_ACTIVITY_LOGS_TABLE} log
          WHERE log.competition_id=:competitionId AND log.profile_id=:profileId AND log.type='DROP_VOTE_EDIT'
            AND NOT EXISTS (
              SELECT 1 FROM ${COMPETITION_VOTE_HISTORY_TABLE} linked
              WHERE linked.competition_id=:competitionId
                AND linked.voter_profile_id=:profileId
                AND log.id=CONCAT(linked.competition_id,':',linked.sequence)
            )
            AND JSON_EXTRACT(log.contents,'$.reason') IS NULL
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(log.contents,'$.oldVote')) AS SIGNED)
              <>CAST(JSON_UNQUOTE(JSON_EXTRACT(log.contents,'$.newVote')) AS SIGNED)
        ) activity GROUP BY activity.drop_id
      ) recent ON recent.drop_id=e.drop_id`;
      order =
        'recent.last_voted_at IS NULL ASC,recent.last_voted_at DESC,e.drop_id ASC';
    }
    const rows = await this.query<CompetitionMyVote>(
      'myVotes',
      `SELECT v.entry_id,e.drop_id,v.value,v.credit_spent,e.status AS entry_status FROM ${COMPETITION_VOTES_TABLE} v
       JOIN ${COMPETITION_ENTRIES_TABLE} e ON e.id=v.entry_id AND e.competition_id=v.competition_id
       ${joins}
       WHERE v.competition_id=:competitionId AND v.voter_profile_id=:profileId AND v.value<>0 AND e.status='ACTIVE'
         AND ${competitionEntryVisibleSql('e')}
       ORDER BY ${order} LIMIT :offset,:limit`,
      { competitionId: record.id, profileId, offset, limit },
      ctx
    );
    return rows.map((row) => ({
      ...row,
      value: Number(row.value),
      credit_spent: Number(row.credit_spent)
    }));
  }

  public async awards(
    record: Pick<CompetitionRoutingRecord, 'id'>,
    offset: number,
    limit: number,
    ctx: RequestContext,
    entryIds?: readonly string[]
  ): Promise<NativeDecisionAward[]> {
    const rows = await this.query<{
      id: string;
      competition_id: string;
      decision_id: string;
      entry_id: string;
      outcome_position: number | string;
      award: string | Record<string, unknown>;
    }>(
      'awards',
      `SELECT award.* FROM ${COMPETITION_OUTCOME_AWARDS_TABLE} award
       JOIN ${COMPETITION_ENTRIES_TABLE} e ON e.id=award.entry_id AND e.competition_id=award.competition_id
       left join ${COMPETITION_DECISIONS_TABLE} decision on decision.id=award.decision_id and decision.competition_id=award.competition_id
       left join ${COMPETITION_DECISION_WINNERS_TABLE} winner on winner.decision_id=award.decision_id and winner.competition_id=award.competition_id and winner.entry_id=award.entry_id
       WHERE award.competition_id=:competitionId AND ${competitionEntryVisibleSql('e')}
       ${entryIds ? "AND award.entry_id in (:entryIds) AND (e.status='ACTIVE' OR award.decision_id=e.decision_id)" : ''}
       ORDER BY coalesce(decision.scheduled_at,award.created_at),winner.\`rank\`,e.drop_id,award.outcome_position,award.id ${entryIds ? '' : 'LIMIT :offset,:limit'}`,
      { competitionId: record.id, offset, limit, entryIds },
      ctx
    );
    return rows.map(
      (row) =>
        ({
          id: row.id,
          competition_id: row.competition_id,
          decision_id: row.decision_id,
          entry_id: row.entry_id,
          outcome_position: Number(row.outcome_position),
          ...(typeof row.award === 'string' ? JSON.parse(row.award) : row.award)
        }) as NativeDecisionAward
    );
  }
}

export const competitionInteractionRepository =
  new CompetitionInteractionRepository(dbSupplier);
