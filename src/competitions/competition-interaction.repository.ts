import { competitionEntryVisibleSql } from '@/competitions/competition-entry-visibility';
import { randomUUID } from 'node:crypto';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE
} from '@/constants';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { CompetitionRoutingRecord } from './competition.types';
import { NativeDecisionAward } from './native-competition-runtime.repository';

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
    ctx: RequestContext
  ): Promise<CompetitionMyVote[]> {
    const rows = await this.query<CompetitionMyVote>(
      'myVotes',
      `SELECT v.entry_id,e.drop_id,v.value,v.credit_spent,e.status AS entry_status FROM ${COMPETITION_VOTES_TABLE} v
       JOIN ${COMPETITION_ENTRIES_TABLE} e ON e.id=v.entry_id AND e.competition_id=v.competition_id
       WHERE v.competition_id=:competitionId AND v.voter_profile_id=:profileId AND v.value<>0
         AND ${competitionEntryVisibleSql('e')}
       ORDER BY e.submitted_at DESC,e.id DESC LIMIT :offset,:limit`,
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
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
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
       ORDER BY coalesce(decision.scheduled_at,award.created_at),winner.\`rank\`,e.drop_id,award.outcome_position,award.id LIMIT :offset,:limit`,
      { competitionId: record.id, offset, limit },
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
