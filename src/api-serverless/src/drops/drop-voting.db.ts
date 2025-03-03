import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE
} from '../../../constants';
import { DropVoterStateEntity } from '../../../entities/IDropVoterState';
import { DropVoteCreditSpending } from '../../../entities/IDropVoteCreditSpending';
import { Time } from '../../../time';
import { DropRealVoteInTimeWithoutId } from '../../../entities/IDropRealVoteInTime';
import { WaveLeaderboardEntryWithoutId } from '../../../entities/IWaveLeaderboardEntry';
import { DropType } from '../../../entities/IDrop';

const mysql = require('mysql');

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

  public async lockDropVoterStateForDrop(
    param: { voterId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCurrentState`);
    const votes = await this.db
      .oneOrNull<{ votes: number }>(
        `
      select votes from ${DROP_VOTER_STATE_TABLE}
      where voter_id = :voterId and drop_id = :drop_id
      for update
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

  async getDropsRanks(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getDropsRanks`);
    const sql = `
    SELECT drop_id, rnk
    FROM (select d.id as drop_id,
                 rank() over (partition by d.wave_id order by cast(ifnull(r.vote, 0) as signed) desc , cast(ifnull(r.last_increased, d.created_at) as signed) asc) as rnk
          from ${DROPS_TABLE} d
                   left join ${DROP_RANK_TABLE} r on r.drop_id = d.id
          where d.drop_type = '${DropType.PARTICIPATORY}') drop_ranks
    WHERE drop_id in (:dropIds)
  `;
    const results = await this.db.execute<{ drop_id: string; rnk: number }>(
      sql,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getDropsRanks`);
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.rnk;
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

  async getDropsLastVoteIncreaseTimes(
    waveId: string,
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    const result = await this.db.execute<{
      drop_id: string;
      last_increased: number;
    }>(
      `select d.id as drop_id, ifnull(dr.last_increased, d.created_at) as last_increased from ${DROPS_TABLE} d
      left join ${DROP_RANK_TABLE} dr.drop_id = d.id
      where d.wave_id = :wave_id`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    return result.reduce((acc, it) => {
      acc[it.drop_id] = it.last_increased;
      return acc;
    }, {} as Record<string, number>);
  }

  async getDropsVoteStatesInTimespan(
    params: {
      fromTime: number;
      toTime: number;
      waveId: string;
    },
    ctx: RequestContext
  ): Promise<DropRealVoteInTimeWithoutId[]> {
    ctx.timer?.start(`${this.constructor.name}->getDropsVoteStates`);
    const states = await this.db.execute<DropRealVoteInTimeWithoutId>(
      `
      select drop_id, wave_id, timestamp, vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE}
      where wave_id = :waveId
        and timestamp > :fromTime
        and timestamp < :toTime
      union all
      select drop_id, wave_id, :fromTime as timestamp, vote
      from ${DROP_REAL_VOTE_IN_TIME_TABLE}
      where id in (select max(id) as id
                   from drop_real_vote_in_time
                   where wave_id = :waveId
                     and timestamp <= :fromTime
                   group by drop_id)
      order by timestamp desc
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getDropsVoteStates`);
    return states;
  }

  async getWavesPastLeaderboardCalculationTime(
    now: Time,
    ctx: RequestContext
  ): Promise<
    {
      wave_id: string;
      time_lock_ms: number;
      latest_leaderboard_calculation: number | null;
      latest_vote_change: number | null;
    }[]
  > {
    ctx.timer?.start(`${this.constructor.name}->getWavesPastLeaderboardTime`);
    const overdueTime = now.minusMinutes(5).toMillis();
    const results = await this.db.execute<{
      wave_id: string;
      time_lock_ms: number;
      latest_leaderboard_calculation: number | null;
      latest_vote_change: number | null;
    }>(
      `
      select w.id as wave_id, w.time_lock_ms, lb.timestamp as latest_leaderboard_calculation, dv.timestamp as latest_vote_change from waves w
      left join (select wave_id, max(timestamp) as timestamp from ${WAVE_LEADERBOARD_ENTRIES_TABLE} group by 1) lb on w.id = lb.wave_id
      left join (select wave_id, max(timestamp) as timestamp from ${DROP_REAL_VOTE_IN_TIME_TABLE} where timestamp <= :now group by 1) dv on w.id = dv.wave_id
      where w.time_lock_ms is not null and (lb.timestamp is null or lb.timestamp < :overdueTime)
      `,
      { overdueTime, now },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getWavesPastLeaderboardTime`);
    return results;
  }

  async updateLeaderboardTimesForAllWavesDrops(
    waveIds: string[],
    time: number,
    ctx: RequestContext
  ) {
    if (waveIds.length === 0) {
      return;
    }
    ctx.timer?.start(
      `${this.constructor.name}->updateLeaderboardTimesForAllWavesDrops`
    );
    await this.db.execute(
      `
      update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set timestamp = :time where wave_id in (:waveIds)
      `,
      { waveIds, time },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->updateLeaderboardTimesForAllWavesDrops`
    );
  }

  async reinsertWaveLeaderboardData(
    entries: WaveLeaderboardEntryWithoutId[],
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->reinsertWaveLeaderboardData`);
    await this.db.execute(
      `delete from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
    if (!entries.length) {
      ctx.timer?.stop(`${this.constructor.name}->reinsertWaveLeaderboardData`);
      return;
    }
    const sql = `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id, wave_id, timestamp, vote, rank) values ${entries
      .map(
        (entry) =>
          `(${mysql.escape(entry.drop_id)}, ${mysql.escape(
            entry.wave_id
          )}, ${mysql.escape(entry.timestamp)}, ${mysql.escape(
            entry.vote
          )}, ${mysql.escape(entry.rank)})`
      )
      .join(', ')}`;
    await this.db.execute(sql, undefined, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->reinsertWaveLeaderboardData`);
  }
}

export type NewDropVoteCreditSpending = Omit<DropVoteCreditSpending, 'id'>;
export type NewDropVoterState = Omit<DropVoterStateEntity, 'id'>;

export const dropVotingDb = new DropVotingDb(dbSupplier);
