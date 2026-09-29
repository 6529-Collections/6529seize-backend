import {
  COMPETITIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  DROP_VOTER_STATE_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { waveReadAccessSql } from '@/waves/wave-read-access-sql';

export function publicCompetitionWaveSql(alias: string): string {
  return `${waveReadAccessSql(alias, false)} and coalesce(${alias}.is_direct_message, 0) = 0
    and not exists (select 1 from ${WAVES_TABLE} dm_parent
      where dm_parent.id = ${alias}.parent_wave_id and dm_parent.is_direct_message = 1)`;
}

/** Native privileges are granted to one competition, never inherited from its hub. */
export function nativeMainStageEntriesSource(
  status: 'ACTIVE' | 'WINNER'
): string {
  const winnerJoin =
    status === 'WINNER'
      ? `join ${COMPETITION_DECISION_WINNERS_TABLE} winner on winner.competition_id = entry.competition_id
      and winner.entry_id = entry.id and winner.decision_id = entry.decision_id`
      : '';
  const lifecycle =
    status === 'ACTIVE' ? "and competition.lifecycle = 'PUBLISHED'" : '';
  return `select entry.id, entry.competition_id, entry.drop_id, entry.submitter_id, entry.wave_id, entry.decision_id
    from ${COMPETITION_ENTRIES_TABLE} entry
    join ${COMPETITIONS_TABLE} competition on competition.id = entry.competition_id
      and competition.wave_id = entry.wave_id and competition.storage_mode = 'NATIVE'
      and competition.published_at is not null ${lifecycle}
    join ${COMPETITION_CAPABILITIES_TABLE} cap on cap.competition_id = competition.id
      and cap.wave_id = competition.wave_id and cap.capability = 'MAIN_STAGE'
    join ${WAVES_TABLE} hub on hub.id = competition.wave_id and ${publicCompetitionWaveSql('hub')}
    ${winnerJoin}
    where entry.status = '${status}'`;
}

export class CompetitionMainStageRepository extends LazyDbAccessCompatibleService {
  public async isDesignated(
    competitionId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const rows = await this.db.execute(
      `select c.id from ${COMPETITIONS_TABLE} c
       join ${COMPETITION_CAPABILITIES_TABLE} cap on cap.competition_id = c.id and cap.wave_id = c.wave_id
       join ${WAVES_TABLE} hub on hub.id = c.wave_id and ${publicCompetitionWaveSql('hub')}
       where c.id = :competitionId and c.storage_mode = 'NATIVE' and cap.capability = 'MAIN_STAGE'`,
      { competitionId },
      { wrappedConnection: ctx.connection }
    );
    return rows.length > 0;
  }

  public async totalActiveVotes(
    legacyWaveId: string | null,
    ctx: RequestContext
  ): Promise<number> {
    const [row] = await this.db.execute<{ total_votes: number | null }>(
      `select sum(value) as total_votes from (
        select abs(v.votes) as value from ${DROP_VOTER_STATE_TABLE} v
        left join ${WAVES_DECISION_WINNER_DROPS_TABLE} winner on winner.drop_id = v.drop_id
        where v.wave_id = :legacyWaveId and winner.drop_id is null
        union all
        select abs(v.value) as value from ${COMPETITION_VOTES_TABLE} v
        join (${nativeMainStageEntriesSource('ACTIVE')}) entry
          on entry.id = v.entry_id and entry.competition_id = v.competition_id
      ) active_votes`,
      { legacyWaveId },
      { wrappedConnection: ctx.connection }
    );
    return Number(row?.total_votes ?? 0);
  }
}

export const competitionMainStageRepository =
  new CompetitionMainStageRepository(dbSupplier);
