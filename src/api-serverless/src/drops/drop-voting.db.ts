import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '../../../constants';
import { DropVoterStateEntity } from '../../../entities/IDropVoterState';
import { DropVoteCreditSpending } from '../../../entities/IDropVoteCreditSpending';
import { Time } from '../../../time';
import { DropRealVoteInTimeWithoutId } from '../../../entities/IDropRealVoteInTime';
import { WaveLeaderboardEntryEntity } from '../../../entities/IWaveLeaderboardEntry';
import { DropType } from '../../../entities/IDrop';
import { DropRealVoterVoteInTimeEntityWithoutId } from '../../../entities/IDropRealVoterVoteInTime';
import { DbPoolName } from '../../../db-query.options';
import { WinnerDropVoterVoteEntity } from '../../../entities/IWinnerDropVoterVote';

export class DropVotingDb extends LazyDbAccessCompatibleService {
  public async upsertState(state: NewDropVoterState, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->upsertState`);
    await this.db.execute(
      `
      insert into ${DROP_VOTER_STATE_TABLE} (voter_id, drop_id, votes, wave_id) 
      values (:voter_id, :drop_id, :votes, :wave_id)
      on duplicate key update votes = :votes
    `,
      state,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
  }

  public async upsertAggregateDropRank(
    {
      drop_id,
      change,
      wave_id
    }: { drop_id: string; change: number; wave_id: string },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->upsertAggregateDropRank`);
    await this.db.execute(
      `
      insert into ${DROP_RANK_TABLE} (drop_id, last_increased, vote, wave_id) 
      values (:drop_id, :last_increased, :change, :wave_id)
      on duplicate key update vote = vote + :change ${
        change > 0 ? `, last_increased = :last_increased` : ``
      }
    `,
      {
        drop_id,
        last_increased: change > 0 ? Time.currentMillis() : 0,
        wave_id,
        change
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertAggregateDropRank`);
  }

  public async lockDropsCurrentRealVote(dropId: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->lockDropsCurrentTealVote`);
    await this.db.oneOrNull<{ vote: number }>(
      `select id from ${DROP_REAL_VOTE_IN_TIME_TABLE} where drop_id = :dropId order by timestamp desc limit 1 for update`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->lockDropsCurrentTealVote`);
  }

  public async getDropVoterStateForDrop(
    param: { voterId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCurrentState`);
    const votes = await this.db
      .oneOrNull<{ votes: number }>(
        `
      select votes from ${DROP_VOTER_STATE_TABLE}
      where voter_id = :voterId and drop_id = :drop_id
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.votes ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getCurrentState`);
    return votes;
  }

  public async insertCreditSpending(
    creditSpending: NewDropVoteCreditSpending,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertCreditSpending`);
    await this.db.execute(
      `
      insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (
        voter_id, 
        drop_id, 
        credit_spent, 
        created_at, 
        wave_id
      )
      values (
        :voter_id, 
        :drop_id, 
        :credit_spent, 
        :created_at, 
        :wave_id
      )
    `,
      creditSpending,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->insertCreditSpending`);
  }

  public async getVotingCreditLockedInWaveForVoter(
    { voterId, waveId }: { voterId: string; waveId: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(
      `${this.constructor.name}->getVotingCreditLockedInWaveForVoter`
    );
    const result = await this.db
      .execute<{ credit_spent: number; wave_id: string }>(
        `
      select 
      sum(abs(s.votes)) as credit_spent from ${DROP_VOTER_STATE_TABLE} s
      join ${DROPS_TABLE} d on d.id = s.drop_id and d.drop_type = '${DropType.PARTICIPATORY}'
      where s.voter_id = :voterId and s.wave_id = :waveId
    `,
        {
          voterId,
          waveId
        },
        { wrappedConnection: ctx.connection }
      )
      .then((results) => results[0]?.credit_spent);
    ctx.timer?.stop(
      `${this.constructor.name}->getVotingCreditLockedInWaveForVoter`
    );
    return result;
  }

  public async mergeOnProfileIdChange(
    {
      previous_id,
      new_id
    }: {
      previous_id: string;
      new_id: string;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->mergeOnProfileIdChange`);
    await Promise.all([
      this.db.execute(
        `
        update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} 
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `
        update ${DROP_VOTER_STATE_TABLE} 
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `update ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} set voter_id = :new_id where voter_id = :previous_id`,
        { new_id, previous_id },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `update ${WINNER_DROP_VOTER_VOTES_TABLE} set voter_id = :new_id where voter_id = :previous_id`,
        { new_id, previous_id },
        { wrappedConnection: ctx.connection }
      )
    ]);
    ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
  }

  public async getTallyForDrops(
    { dropIds }: { dropIds: string[] },
    ctx: RequestContext
  ): Promise<
    Record<string, { tally: number; total_number_of_voters: number }>
  > {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getTallyForDrops`);
    const sql = `
      select drop_id, sum(votes) as tally, count(distinct voter_id) as total_number_of_voters
      from ${DROP_VOTER_STATE_TABLE}
      where drop_id in (:dropIds)
        and votes <> 0
        group by 1
    `;
    const result = await this.db
      .execute<{
        drop_id: string;
        tally: number;
        total_number_of_voters: number;
      }>(sql, { dropIds }, { wrappedConnection: ctx.connection })
      .then((result) =>
        dropIds.reduce(
          (acc, drop_id) => ({
            ...acc,
            [drop_id]: {
              tally: result.find((it) => it.drop_id === drop_id)?.tally ?? 0,
              total_number_of_voters:
                result.find((it) => it.drop_id === drop_id)
                  ?.total_number_of_voters ?? 0
            }
          }),
          {} as Record<
            string,
            { tally: number; total_number_of_voters: number }
          >
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getTallyForDrops`);
    return result;
  }

  public async getWeightedDropRates(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWeightedDropRates`);
    const sql = `
      select drop_id, vote
      from ${WAVE_LEADERBOARD_ENTRIES_TABLE}
      where drop_id in (:dropIds)
    `;
    const result = await this.db
      .execute<{
        drop_id: string;
        vote: number;
      }>(sql, { dropIds }, { wrappedConnection: ctx.connection })
      .then((result) =>
        result.reduce(
          (acc, it) => ({
            ...acc,
            [it.drop_id]: it.vote
          }),
          {} as Record<string, number>
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getWeightedDropRates`);
    return result;
  }

  public async getVotersTotalLockedCreditInWaves(
    { waveIds, voterId }: { waveIds: string[]; voterId: string },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (waveIds.length === 0) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->getVotersTotalLockedCreditInWaves`
    );
    const sql = `
      select s.wave_id, sum(abs(s.votes)) as total_votes from ${DROP_VOTER_STATE_TABLE} s
      join ${DROPS_TABLE} d on d.id = s.drop_id and d.drop_type = '${DropType.PARTICIPATORY}'
      where s.wave_id in (:waveIds) and s.voter_id = :voterId
      group by 1
    `;
    const result = await this.db
      .execute<{
        wave_id: string;
        total_votes: number;
      }>(sql, { waveIds, voterId }, { wrappedConnection: ctx.connection })
      .then((results) =>
        waveIds.reduce(
          (acc, waveId) => ({
            ...acc,
            [waveId]:
              results.find((it) => it.wave_id === waveId)?.total_votes ?? 0
          }),
          {} as Record<string, number>
        )
      );
    ctx.timer?.stop(
      `${this.constructor.name}->getVotersTotalLockedCreditInWaves`
    );
    return result;
  }

  public async getVotersActiveVoteForDrops(
    { dropIds, voterId }: { dropIds: string[]; voterId: string },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getVotersActiveVoteForDrops`);
    const sql = `
  select drop_id, sum(votes) as total_votes from ${DROP_VOTER_STATE_TABLE}
  where drop_id in (:dropIds) and voter_id = :voterId
  group by 1
`;
    const result = await this.db
      .execute<{
        drop_id: string;
        total_votes: number;
      }>(sql, { dropIds, voterId }, { wrappedConnection: ctx.connection })
      .then((results) =>
        dropIds.reduce(
          (acc, drop_id) => ({
            ...acc,
            [drop_id]:
              results.find((it) => it.drop_id === drop_id)?.total_votes ?? 0
          }),
          {} as Record<string, number>
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getVotersActiveVoteForDrops`);
    return result;
  }

  public async findDropsTopContributors(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, { votes: number; voter_id: string }[]>> {
    if (dropIds.length === 0) {
      return {};
    }
    return await this.db
      .execute<{
        drop_id: string;
        voter_id: string;
        votes: number;
      }>(
        `
      with ranked_voters as (
        select 
          drop_id, 
          voter_id, 
          votes, 
          row_number() over (partition by drop_id order by votes desc) as rn
        from ${DROP_VOTER_STATE_TABLE} 
        where drop_id in (:dropIds) and votes <> 0
      )
      select 
        drop_id, 
        voter_id, 
        votes 
      from ranked_voters 
      where rn <= 5
    `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => {
        return res.reduce(
          (acc, { drop_id, voter_id, votes }) => ({
            ...acc,
            [drop_id]: [...(acc[drop_id] ?? []), { voter_id, votes }]
          }),
          {} as Record<string, { votes: number; voter_id: string }[]>
        );
      });
  }

  async deleteForDrop(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_VOTER_STATE_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendings(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRanks(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRealVoteInTimes(dropId: string, ctx: RequestContext) {
    return await this.db.execute(
      `delete from ${DROP_REAL_VOTE_IN_TIME_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRealVoterVoteInTimes(dropId: string, ctx: RequestContext) {
    return await this.db.execute(
      `delete from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRealVoterVoteInTimesForWave(
    waveId: string,
    ctx: RequestContext
  ) {
    return await this.db.execute(
      `delete from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRealVoteInTimesForWave(waveId: string, ctx: RequestContext) {
    return await this.db.execute(
      `delete from ${DROP_REAL_VOTE_IN_TIME_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_VOTER_STATE_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendingsForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRanksForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async getParticipationDropsRealtimeRanks(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->getParticipationDropsRealtimeRanks`
    );
    const results = await this.db.execute<{ drop_id: string; rnk: number }>(
      `
          WITH needed_waves AS (SELECT DISTINCT wave_id
                                FROM ${DROPS_TABLE}
                                WHERE id IN (:dropIds))
          SELECT d.id  AS drop_id,
                 RANK() OVER (
                     PARTITION BY d.wave_id
                     ORDER BY IFNULL(r.vote, 0) DESC,
                         IFNULL(r.last_increased, d.created_at) ASC
                     ) AS rnk
          FROM ${DROPS_TABLE} d
                   LEFT JOIN ${DROP_RANK_TABLE} r
                             ON r.drop_id = d.id
          WHERE d.drop_type = 'PARTICIPATORY'
            AND d.wave_id IN (SELECT wave_id FROM needed_waves)
      `,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->getParticipationDropsRealtimeRanks`
    );
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.rnk;
      return acc;
    }, {} as Record<string, number>);
  }

  async getTimeLockedDropsWeightedVotes(
    dropIds: string[],
    ctx: RequestContext
  ) {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->getTimeLockedDropsWeightedVotes`
    );
    const sql = `
    SELECT drop_id, rnk
    FROM (select d.id as drop_id,
                 rank() over (partition by d.wave_id order by cast(ifnull(r.vote, 0) as signed) desc , cast(ifnull(r.timestamp, d.created_at) as signed) asc) as rnk
          from ${DROPS_TABLE} d
                   join ${WAVES_TABLE} w on w.id = d.wave_id
                   left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} r on r.drop_id = d.id
          where d.drop_type = '${DropType.PARTICIPATORY}' and w.time_lock_ms is not null and w.time_lock_ms > 0) drop_ranks
    WHERE drop_id in (:dropIds)
  `;
    const results = await this.db.execute<{ drop_id: string; rnk: number }>(
      sql,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->getTimeLockedDropsWeightedVotes`
    );
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.rnk;
      return acc;
    }, {} as Record<string, number>);
  }

  async getWinningDropsRatersCount(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWinningDropsRatersCount`);
    const sql = `select drop_id, count(*) as raters_count from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id in (:dropIds) and votes <> 0 group by 1`;
    const results = await this.db.execute<{
      drop_id: string;
      raters_count: number;
    }>(sql, { dropIds }, { wrappedConnection: ctx.connection });
    ctx.timer?.stop(`${this.constructor.name}->getWinningDropsRatersCount`);
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.raters_count;
      return acc;
    }, {} as Record<string, number>);
  }

  async getWinningDropsTopRaters(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WinnerDropVoterVoteEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWinningDropsTopRaters`);
    const sql = `select * from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id in (:dropIds) and votes <> 0 order by votes desc limit 5`;
    const results = await this.db.execute<WinnerDropVoterVoteEntity>(
      sql,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getWinningDropsTopRaters`);
    return results.reduce((acc, it) => {
      if (!acc[it.drop_id]) {
        acc[it.drop_id] = [];
      }
      acc[it.drop_id].push(it);
      return acc;
    }, {} as Record<string, WinnerDropVoterVoteEntity[]>);
  }

  async getWinningDropsRatingsByVoter(
    dropIds: string[],
    voterId: string,
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWinningDropsRatersCount`);
    const sql = `select drop_id, votes from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id in (:dropIds) and voter_id = :voterId and votes <> 0`;
    const results = await this.db.execute<{
      drop_id: string;
      votes: number;
    }>(sql, { dropIds, voterId }, { wrappedConnection: ctx.connection });
    ctx.timer?.stop(`${this.constructor.name}->getWinningDropsRatersCount`);
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.votes;
      return acc;
    }, {} as Record<string, number>);
  }

  async saveDropRealVoteInTime(
    entity: DropRealVoteInTimeWithoutId,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `
      insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (
        drop_id,
        wave_id,
        timestamp,
        vote
      ) values (
        :drop_id,
        :wave_id,
        :timestamp,
        :vote       
      )
      `,
      entity,
      { wrappedConnection: ctx.connection }
    );
  }

  async snapShotDropsCurrentVote(
    dropId: string,
    time: number,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `
        insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (
            drop_id,
            wave_id,
            timestamp,
            vote
        ) select 
              drop_id,
              wave_id,
              :time,
              vote
        from ${DROP_RANK_TABLE} where drop_id = :dropId
      `,
      { dropId, time },
      { wrappedConnection: ctx.connection }
    );
  }

  async getDropsInNeedOfLeaderboardUpdate(
    ctx: RequestContext
  ): Promise<{ drop_id: string; time_lock_ms: number; wave_id: string }[]> {
    return this.db.execute<{
      drop_id: string;
      time_lock_ms: number;
      wave_id: string;
    }>(
      `select lvc.drop_id as drop_id, lvc.time_lock_ms as time_lock_ms, lvc.wave_id as wave_id
from (select d.drop_id, d.wave_id as wave_id, w.time_lock_ms as time_lock_ms, max(d.timestamp) as timestamp
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} d
               join ${WAVES_TABLE} w
                    on w.id = d.wave_id and w.time_lock_ms is not null and w.time_lock_ms > 0
               join ${DROPS_TABLE} dr on d.drop_id = dr.id
               where dr.drop_type = '${DropType.PARTICIPATORY}'
      group by 1, 2, 3) lvc
         left join wave_leaderboard_entries lb
                   on lvc.drop_id = lb.drop_id and lvc.wave_id = lb.wave_id
where lvc.timestamp >= (ifnull(lb.timestamp, 0) - lvc.time_lock_ms)`,
      undefined,
      { wrappedConnection: ctx.connection }
    );
  }

  async getDropVoteStatesInTimespan(
    params: {
      fromTime: number;
      toTime: number;
      dropId: string;
    },
    ctx: RequestContext
  ): Promise<DropRealVoteInTimeWithoutId[]> {
    ctx.timer?.start(`${this.constructor.name}->getDropVoteStatesInTimespan`);
    const states = await this.db.execute<DropRealVoteInTimeWithoutId>(
      `
      select drop_id, wave_id, timestamp, vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE}
      where drop_id = :dropId
        and timestamp > :fromTime
        and timestamp < :toTime
      union all
      select drop_id, wave_id, :fromTime as timestamp, vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE}
      where id in (
                     select max(id) as id
                     from ${DROP_REAL_VOTE_IN_TIME_TABLE}
                     where drop_id = :dropId
                     and timestamp <= :fromTime
      )
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getDropVoteStatesInTimespan`);
    return states;
  }

  async getWavesParticipatoryDropsVoteStatesInTimespan(
    params: {
      fromTime: number;
      toTime: number;
      waveId: string;
    },
    ctx: RequestContext
  ): Promise<DropRealVoteInTimeWithoutId[]> {
    ctx.timer?.start(
      `${this.constructor.name}->getWavesParticipatoryDropsVoteStatesInTimespan`
    );
    const states = await this.db.execute<DropRealVoteInTimeWithoutId>(
      `
      select drv_1.drop_id as drop_id, drv_1.wave_id as wave_id, drv_1.timestamp as timestamp, drv_1.vote as vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_1
      join ${DROPS_TABLE} d1 on d1.id = drv_1.drop_id
      where d1.drop_type = '${DropType.PARTICIPATORY}' 
        and drv_1.wave_id = :waveId
        and drv_1.timestamp > :fromTime
        and drv_1.timestamp < :toTime
      union all
      select drv_2.drop_id as drop_id, drv_2.wave_id as wave_id, :fromTime as timestamp, drv_2.vote as vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_2
      where drv_2.id in (
                     select max(drv_2_i.id) as id
                     from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_2_i
                     join ${DROPS_TABLE} d2 on d2.id = drv_2_i.drop_id
                     where d2.drop_type = '${DropType.PARTICIPATORY}' 
                     and drv_2_i.wave_id = :waveId
                     and drv_2_i.timestamp <= :fromTime
      )
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->getWavesParticipatoryDropsVoteStatesInTimespan`
    );
    return states;
  }

  async getDropsParticipatoryDropsVoteStatesInTimespan(
    params: {
      fromTime: number;
      toTime: number;
      dropId: string;
    },
    ctx: RequestContext
  ): Promise<DropRealVoteInTimeWithoutId[]> {
    ctx.timer?.start(
      `${this.constructor.name}->getDropsParticipatoryDropsVoteStatesInTimespan`
    );
    const states = await this.db
      .execute<DropRealVoteInTimeWithoutId>(
        `
      select drv_1.drop_id as drop_id, drv_1.wave_id as wave_id, drv_1.timestamp as timestamp, drv_1.vote as vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_1
      join ${DROPS_TABLE} d1 on d1.id = drv_1.drop_id
      where d1.drop_type = '${DropType.PARTICIPATORY}' 
        and drv_1.drop_id = :dropId
        and drv_1.timestamp > :fromTime
        and drv_1.timestamp < :toTime
      union all
      select drv_2.drop_id as drop_id, drv_2.wave_id as wave_id, :fromTime as timestamp, drv_2.vote as vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_2
      where drv_2.id in (
                     select max(drv_2_i.id) as id
                     from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv_2_i
                     join ${DROPS_TABLE} d2 on d2.id = drv_2_i.drop_id
                     where d2.drop_type = '${DropType.PARTICIPATORY}' 
                     and drv_2_i.drop_id = :dropId
                     and drv_2_i.timestamp <= :fromTime
      )
      `,
        params,
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.map((it) => ({ ...it, timestamp: +it.timestamp, vote: +it.vote }))
      );
    ctx.timer?.stop(
      `${this.constructor.name}->getDropsParticipatoryDropsVoteStatesInTimespan`
    );
    return states;
  }

  async upsertWaveLeaderboardEntry(
    entry: WaveLeaderboardEntryEntity,
    ctx: RequestContext
  ) {
    await this.db.execute(
      `
          insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id, wave_id, timestamp, vote)
          values (:drop_id, :wave_id, :timestamp, :vote)
          on duplicate key update vote = :vote, timestamp = :timestamp
      `,
      entry,
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteStaleLeaderboardEntries(ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->deleteStaleLeaderboardEntries`);
    const staleLeaderboardEntriesDropIds = await this.db
      .execute<{
        drop_id: string;
      }>(
        `select d.id as drop_id from ${DROPS_TABLE} d
      join waves w on d.wave_id = w.id
      join ${WAVE_LEADERBOARD_ENTRIES_TABLE} lb on lb.drop_id = d.id
      where d.drop_type <> '${DropType.PARTICIPATORY}' or w.time_lock_ms is null or w.time_lock_ms = 0`,
        undefined,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      )
      .then((res) => res.map((it) => it.drop_id));
    if (staleLeaderboardEntriesDropIds.length) {
      await this.db.execute(
        `delete from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where drop_id in (:dropIds)`,
        { dropIds: staleLeaderboardEntriesDropIds },
        { wrappedConnection: ctx.connection }
      );
    }
    ctx.timer?.stop(`${this.constructor.name}->deleteStaleLeaderboardEntries`);
  }

  async deleteDropsLeaderboardEntry(dropId: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->deleteDropsLeaderboardEntry`);
    await this.db.execute(
      `delete from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->deleteDropsLeaderboardEntry`);
  }

  async deleteWavesLeaderboardEntries(waveId: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->deleteWavesLeaderboardEntries`);
    await this.db.execute(
      `delete from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->deleteWavesLeaderboardEntries`);
  }

  async getLastVoteIncreaseTimesForEachDrop(
    dropIdsInTie: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIdsInTie.length) {
      return {};
    }
    return this.db
      .execute<{ drop_id: string; timestamp: number }>(
        `
               select d.id as drop_id,
               cast(ifnull(r.last_increased, d.created_at) as signed) as timestamp
               from ${DROPS_TABLE} d
                        left join ${DROP_RANK_TABLE} r ON r.drop_id = d.id
               where d.id in (:dropIdsInTie)
                 and d.drop_type = '${DropType.PARTICIPATORY}'
      `,
        { dropIdsInTie },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.reduce((acc, it) => {
          acc[it.drop_id] = it.timestamp;
          return acc;
        }, {} as Record<string, number>)
      );
  }

  async transferAllDropVoterStatesToWinnerDropsVotes(
    { dropIds }: { dropIds: string[] },
    ctx: RequestContext
  ) {
    if (!dropIds.length) {
      return;
    }
    const stateIds = await this.db
      .execute<{
        id: number;
      }>(
        `select max(id) as id from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where drop_id in (:dropIds) group by drop_id`,
        { dropIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => res.map((it) => it.id));
    if (stateIds.length) {
      await this.db.execute(
        `
       insert into ${WINNER_DROP_VOTER_VOTES_TABLE} (voter_id, votes, drop_id, wave_id)
       select voter_id, vote, drop_id, wave_id from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where id in (:stateIds)
      `,
        { stateIds },
        { wrappedConnection: ctx.connection }
      );
    }
    await Promise.all([
      this.db.execute(
        `delete from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where drop_id in (:dropIds)`,
        { dropIds },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `delete from ${DROP_VOTER_STATE_TABLE} where drop_id in (:dropIds)`,
        { dropIds },
        { wrappedConnection: ctx.connection }
      )
    ]);
  }

  async getAllVoteChangeLogsForGivenDropsInTimeframe(
    params: {
      fromTime: number;
      toTime: number;
      dropIds: string[];
    },
    ctx: RequestContext
  ): Promise<DropRealVoterVoteInTimeEntityWithoutId[]> {
    ctx.timer?.start(
      `${this.constructor.name}->getAllVoteChangeLogsForGivenDropsInTimeframe`
    );
    if (!params.dropIds.length) {
      return [];
    }
    const states =
      await this.db.execute<DropRealVoterVoteInTimeEntityWithoutId>(
        `
      select drv_1.drop_id as drop_id, drv_1.wave_id as wave_id, drv_1.voter_id as voter_id, drv_1.timestamp as timestamp, drv_1.vote as vote
      from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} drv_1
      where drv_1.drop_id in (:dropIds)
        and drv_1.timestamp > :fromTime
        and drv_1.timestamp < :toTime
      union all
      select drv_2.drop_id as drop_id, drv_2.wave_id as wave_id, drv_2.voter_id as voter_id, :fromTime as timestamp, drv_2.vote as vote
      from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} drv_2
      where drv_2.id in (
                     select max(drv_2_i.id) as id
                     from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} drv_2_i
                     where drv_2_i.drop_id in (:dropIds)
                     and drv_2_i.timestamp <= :fromTime
      )
      `,
        params,
        { wrappedConnection: ctx.connection }
      );
    ctx.timer?.stop(
      `${this.constructor.name}->getAllVoteChangeLogsForGivenDropsInTimeframe`
    );
    return Object.values(
      states.reduce((acc, it) => {
        const key = `${it.drop_id}_${it.voter_id}`;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(it);
        return acc;
      }, {} as Record<string, DropRealVoterVoteInTimeEntityWithoutId[]>)
    )
      .map((dropsStates) => {
        if (dropsStates.find((it) => it.timestamp === params.fromTime)) {
          return dropsStates;
        }
        const aDropState = dropsStates[0]!;
        const zeroVote: DropRealVoterVoteInTimeEntityWithoutId = {
          timestamp: params.fromTime,
          vote: 0,
          voter_id: aDropState.voter_id,
          drop_id: aDropState.drop_id,
          wave_id: aDropState.wave_id
        };
        return [...dropsStates, zeroVote];
      })
      .flat();
  }

  async updateLatestVoteValue(
    {
      dropId,
      voterId,
      endTime,
      vote
    }: { dropId: string; voterId: string; endTime: Time; vote: number },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateLatestVoteValue`);
    const timestamp = await this.db
      .oneOrNull<{ timestamp: number }>(
        `
    select max(v.timestamp) as timestamp
                     from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} v
                     where v.drop_id = :dropId and v.voter_id = :voterId
                     and v.timestamp <= :endTime
    `,
        { dropId, voterId, endTime: endTime.toMillis() },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.timestamp ?? null);
    if (timestamp) {
      await this.db.execute(
        `update ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} set vote = :vote where drop_id = :dropId and voter_id = :voterId and timestamp = :timestamp`,
        { dropId, voterId, endTime: endTime.toMillis(), vote, timestamp },
        { wrappedConnection: ctx.connection }
      );
    }
    ctx.timer?.stop(`${this.constructor.name}->updateLatestVoteValue`);
  }

  public async snapshotDropVotersVoteCurrentState(
    entity: DropRealVoterVoteInTimeEntityWithoutId,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertDropRealVoterVoteInTime`);
    await this.db.execute(
      `
      insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (voter_id, drop_id, vote, wave_id, timestamp) 
      values (:voter_id, :drop_id, :vote, :wave_id, :timestamp)
    `,
      entity,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->insertDropRealVoterVoteInTime`);
  }

  async findWavesTimelockByDropId(dropId: string): Promise<number | null> {
    return this.db
      .oneOrNull<{
        time_lock_ms: number;
      }>(
        `select time_lock_ms from waves where id = (select wave_id from drops where id = :dropId)`,
        { dropId }
      )
      .then((it) => it?.time_lock_ms ?? null);
  }
}

export type NewDropVoteCreditSpending = Omit<DropVoteCreditSpending, 'id'>;
export type NewDropVoterState = Omit<DropVoterStateEntity, 'id'>;

export const dropVotingDb = new DropVotingDb(dbSupplier);
