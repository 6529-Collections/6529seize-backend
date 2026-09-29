import { competitionEntryVisibleSql } from '@/competitions/competition-entry-visibility';
import { randomUUID } from 'node:crypto';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import {
  CompetitionEntryStatus,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { CompetitionRoutingRecord } from './competition.types';
import {
  legacyCompetitionEntryId,
  legacyCompetitionDecisionId,
  stableUuid
} from './competition-id';
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
    if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER) {
      const rows = await this.query<{
        drop_id: string;
        value: number;
        drop_type: string;
      }>(
        'myVotes',
        `SELECT v.drop_id,v.votes AS value,d.drop_type FROM ${DROP_VOTER_STATE_TABLE} v
         JOIN ${DROPS_TABLE} d ON d.id=v.drop_id AND d.wave_id=v.wave_id
         WHERE v.wave_id=:waveId AND v.voter_id=:profileId AND v.votes<>0 AND d.drop_type IN ('PARTICIPATORY','WINNER')
         ORDER BY d.serial_no DESC LIMIT :offset,:limit`,
        { waveId: record.wave_id, profileId, offset, limit },
        ctx
      );
      return rows.map((row) => ({
        entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
        drop_id: row.drop_id,
        value: Number(row.value),
        credit_spent: Math.abs(Number(row.value)),
        entry_status:
          row.drop_type === 'WINNER'
            ? CompetitionEntryStatus.WINNER
            : CompetitionEntryStatus.ACTIVE
      }));
    }
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
    if (record.storage_mode === CompetitionStorageMode.LEGACY_ADAPTER)
      return this.legacyAwards(record, offset, limit, ctx);
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
       WHERE award.competition_id=:competitionId AND ${competitionEntryVisibleSql('e')}
       ORDER BY award.decision_id,award.id LIMIT :offset,:limit`,
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

  private async legacyAwards(
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<NativeDecisionAward[]> {
    const rows = await this.query<{
      drop_id: string;
      decision_time: number | string;
      outcome_position: number;
      award:
        | string
        | Omit<
            NativeDecisionAward,
            | 'id'
            | 'competition_id'
            | 'decision_id'
            | 'entry_id'
            | 'outcome_position'
          >;
    }>(
      'legacyAwards',
      `select winner.drop_id, winner.decision_time, prize.position - 1 as outcome_position,
         json_extract(winner.prizes, concat('$[', prize.position - 1, ']')) as award
       from ${WAVES_DECISION_WINNER_DROPS_TABLE} winner
       join json_table(winner.prizes, '$[*]' columns (position for ordinality)) prize
       where winner.wave_id = :waveId
       order by winner.decision_time asc, winner.ranking asc, winner.drop_id asc, prize.position asc
       limit :offset,:limit`,
      { waveId: record.wave_id, offset, limit },
      ctx
    );
    return rows.map((row) => {
      const entryId = legacyCompetitionEntryId(record.id, row.drop_id);
      const decisionId = legacyCompetitionDecisionId(
        record.id,
        Number(row.decision_time)
      );
      const position = Number(row.outcome_position);
      const award =
        typeof row.award === 'string' ? JSON.parse(row.award) : row.award;
      return {
        ...award,
        id: stableUuid(decisionId, `award:${entryId}:${position}`),
        competition_id: record.id,
        decision_id: decisionId,
        entry_id: entryId,
        outcome_position: position
      };
    });
  }
}

export const competitionInteractionRepository =
  new CompetitionInteractionRepository(dbSupplier);
