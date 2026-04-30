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
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_TABLE,
  WAVES_DECISIONS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE
} from '@/constants';
import { DropVoterStateEntity } from '../../../entities/IDropVoterState';
import { DropVoteCreditSpending } from '../../../entities/IDropVoteCreditSpending';
import { Time } from '../../../time';
import { DropRealVoteInTimeWithoutId } from '../../../entities/IDropRealVoteInTime';
import { WaveLeaderboardEntryEntity } from '../../../entities/IWaveLeaderboardEntry';
import { DropType } from '../../../entities/IDrop';
import { DbPoolName } from '../../../db-query.options';
import { WinnerDropVoterVoteEntity } from '../../../entities/IWinnerDropVoterVote';
import mysql from 'mysql';

type MergedDropRealVoterVoteChange = {
  id: number;
  original_drop_id: string;
  voter_id: string;
  vote: number;
  timestamp: number;
};

export interface DropSubmissionVotingSummary {
  drop_id: string;
  status: DropType.PARTICIPATORY | DropType.WINNER;
  is_open: boolean;
  total_votes_given: number;
  current_calculated_vote: number;
  predicted_final_vote: number;
  voters_count: number;
  place: number;
  forbid_negative_votes: boolean;
}

export function buildMergedDropRealVoteHistoryStates({
  voteChanges,
  targetDropId,
  waveId
}: {
  voteChanges: readonly MergedDropRealVoterVoteChange[];
  targetDropId: string;
  waveId: string;
}): DropRealVoteInTimeWithoutId[] {
  const currentVotesByNominationAndVoter: Record<string, number> = {};
  let currentTotal = 0;
  const rebuiltStates: DropRealVoteInTimeWithoutId[] = [];
  for (const voteChange of voteChanges) {
    const voterStateKey = `${voteChange.original_drop_id}:${voteChange.voter_id}`;
    const previousVote = currentVotesByNominationAndVoter[voterStateKey] ?? 0;
    currentVotesByNominationAndVoter[voterStateKey] = voteChange.vote;
    currentTotal += voteChange.vote - previousVote;

    const previousState = rebuiltStates.at(-1);
    if (previousState?.timestamp === voteChange.timestamp) {
      rebuiltStates.splice(-1, 1, {
        ...previousState,
        vote: currentTotal
      });
      continue;
    }
    rebuiltStates.push({
      drop_id: targetDropId,
      wave_id: waveId,
      timestamp: voteChange.timestamp,
      vote: currentTotal
    });
  }
  return rebuiltStates;
}

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
    const queryOptions = { wrappedConnection: ctx.connection };
    const params = { previous_id, new_id };
    await Promise.all([
      this.db.execute(
        `
        update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} 
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        params,
        queryOptions
      ),
      this.db.execute(
        `update ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} set voter_id = :new_id where voter_id = :previous_id`,
        params,
        queryOptions
      )
    ]);
    await this.db.execute(
      `
        insert into ${WINNER_DROP_VOTER_VOTES_TABLE} (voter_id, drop_id, votes, wave_id)
        select :new_id as voter_id, v.drop_id, v.votes, v.wave_id
        from ${WINNER_DROP_VOTER_VOTES_TABLE} v
        where v.voter_id = :previous_id
        on duplicate key update ${WINNER_DROP_VOTER_VOTES_TABLE}.votes = ${WINNER_DROP_VOTER_VOTES_TABLE}.votes + VALUES(votes)
      `,
      params,
      queryOptions
    );
    await this.db.execute(
      `
      delete from ${WINNER_DROP_VOTER_VOTES_TABLE}
      where voter_id = :previous_id
    `,
      { previous_id },
      queryOptions
    );
    await this.db.execute(
      `
      insert into ${DROP_VOTER_STATE_TABLE} (voter_id, drop_id, votes, wave_id)
      select :new_id as voter_id, s.drop_id, s.votes, s.wave_id
      from ${DROP_VOTER_STATE_TABLE} s
      where s.voter_id = :previous_id
      on duplicate key update ${DROP_VOTER_STATE_TABLE}.votes = ${DROP_VOTER_STATE_TABLE}.votes + VALUES(votes)
    `,
      params,
      queryOptions
    );
    await this.db.execute(
      `
      delete from ${DROP_VOTER_STATE_TABLE}
      where voter_id = :previous_id
    `,
      { previous_id },
      queryOptions
    );
    ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
  }

  public async mergeDropVoteState(
    {
      sourceDropId,
      targetDropId,
      waveId
    }: {
      sourceDropId: string;
      targetDropId: string;
      waveId: string;
    },
    ctx: RequestContext
  ) {
    if (sourceDropId === targetDropId) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->mergeDropVoteState`);
    try {
      if (ctx.connection) {
        await this.mergeDropVoteStateWithConnection(
          {
            sourceDropId,
            targetDropId,
            waveId
          },
          ctx
        );
      } else {
        await this.executeNativeQueriesInTransaction(async (connection) => {
          await this.mergeDropVoteStateWithConnection(
            {
              sourceDropId,
              targetDropId,
              waveId
            },
            { ...ctx, connection }
          );
        });
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->mergeDropVoteState`);
    }
  }

  private async mergeDropVoteStateWithConnection(
    {
      sourceDropId,
      targetDropId,
      waveId
    }: {
      sourceDropId: string;
      targetDropId: string;
      waveId: string;
    },
    ctx: RequestContext
  ) {
    const queryOptions = { wrappedConnection: ctx.connection };
    const params = { sourceDropId, targetDropId, waveId };
    const voteChanges = await this.db.execute<MergedDropRealVoterVoteChange>(
      `
          select id,
                 drop_id as original_drop_id,
                 voter_id,
                 vote,
                 timestamp
          from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE}
          where drop_id in (:dropIds)
          order by timestamp asc, id asc
        `,
      { dropIds: [sourceDropId, targetDropId] },
      queryOptions
    );
    await Promise.all([
      this.db.execute(
        `
            update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}
            set drop_id = :targetDropId
            where drop_id = :sourceDropId
          `,
        params,
        queryOptions
      ),
      this.db.execute(
        `
            update ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE}
            set drop_id = :targetDropId
            where drop_id = :sourceDropId
          `,
        params,
        queryOptions
      )
    ]);

    await this.db.execute(
      `
          insert into ${DROP_VOTER_STATE_TABLE} (voter_id, drop_id, votes, wave_id)
          select voter_id, :targetDropId as drop_id, votes, wave_id
          from ${DROP_VOTER_STATE_TABLE}
          where drop_id = :sourceDropId
          on duplicate key update ${DROP_VOTER_STATE_TABLE}.votes = ${DROP_VOTER_STATE_TABLE}.votes + values(votes)
        `,
      params,
      queryOptions
    );
    await this.db.execute(
      `delete from ${DROP_VOTER_STATE_TABLE} where drop_id = :sourceDropId`,
      params,
      queryOptions
    );

    await this.db.execute(
      `
          insert into ${WINNER_DROP_VOTER_VOTES_TABLE} (voter_id, drop_id, votes, wave_id)
          select voter_id, :targetDropId as drop_id, votes, wave_id
          from ${WINNER_DROP_VOTER_VOTES_TABLE}
          where drop_id = :sourceDropId
          on duplicate key update ${WINNER_DROP_VOTER_VOTES_TABLE}.votes = ${WINNER_DROP_VOTER_VOTES_TABLE}.votes + values(votes)
        `,
      params,
      queryOptions
    );
    await this.db.execute(
      `delete from ${WINNER_DROP_VOTER_VOTES_TABLE} where drop_id = :sourceDropId`,
      params,
      queryOptions
    );

    const [sourceRank, targetRank] = await Promise.all([
      this.db.oneOrNull<{ vote: number; last_increased: number }>(
        `select vote, last_increased from ${DROP_RANK_TABLE} where drop_id = :sourceDropId`,
        params,
        queryOptions
      ),
      this.db.oneOrNull<{ vote: number; last_increased: number }>(
        `select vote, last_increased from ${DROP_RANK_TABLE} where drop_id = :targetDropId`,
        params,
        queryOptions
      )
    ]);

    if (sourceRank || targetRank) {
      await this.db.execute(
        `
            insert into ${DROP_RANK_TABLE} (drop_id, last_increased, vote, wave_id)
            values (:targetDropId, :lastIncreased, :vote, :waveId)
            on duplicate key update last_increased = :lastIncreased, vote = :vote, wave_id = :waveId
          `,
        {
          targetDropId,
          waveId,
          vote: (sourceRank?.vote ?? 0) + (targetRank?.vote ?? 0),
          lastIncreased: Math.max(
            sourceRank?.last_increased ?? 0,
            targetRank?.last_increased ?? 0
          )
        },
        queryOptions
      );
    }
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where drop_id = :sourceDropId`,
      params,
      queryOptions
    );
    await this.rebuildRealVoteHistoryForMergedDrop(
      {
        sourceDropId,
        targetDropId,
        waveId,
        voteChanges
      },
      ctx
    );
    await this.deleteDropsLeaderboardEntry(targetDropId, ctx);
    await this.deleteDropsLeaderboardEntry(sourceDropId, ctx);
  }

  private async rebuildRealVoteHistoryForMergedDrop(
    {
      sourceDropId,
      targetDropId,
      waveId,
      voteChanges
    }: {
      sourceDropId: string;
      targetDropId: string;
      waveId: string;
      voteChanges: readonly MergedDropRealVoterVoteChange[];
    },
    ctx: RequestContext
  ): Promise<void> {
    const queryOptions = { wrappedConnection: ctx.connection };
    await this.db.execute(
      `delete from ${DROP_REAL_VOTE_IN_TIME_TABLE} where drop_id in (:dropIds)`,
      { dropIds: [sourceDropId, targetDropId] },
      queryOptions
    );
    if (!voteChanges.length) {
      return;
    }

    const rebuiltStates = buildMergedDropRealVoteHistoryStates({
      voteChanges,
      targetDropId,
      waveId
    });

    const sql = `
      insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (drop_id, wave_id, timestamp, vote)
      values ${rebuiltStates
        .map(
          (state) =>
            `(${mysql.escape(state.drop_id)}, ${mysql.escape(
              state.wave_id
            )}, ${mysql.escape(state.timestamp)}, ${mysql.escape(state.vote)})`
        )
        .join(', ')}
    `;
    await this.db.execute(sql, undefined, queryOptions);
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

  public async getDropV2SubmissionVotingSummaries(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, DropSubmissionVotingSummary>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(
      `${this.constructor.name}->getDropV2SubmissionVotingSummaries`
    );
    try {
      const now = Time.currentMillis();
      const rows = await this.db.execute<
        Omit<
          DropSubmissionVotingSummary,
          'is_open' | 'forbid_negative_votes'
        > & {
          is_open: boolean | number;
          forbid_negative_votes: boolean | number;
        }
      >(
        `
        with target_submissions as (
          select id, wave_id, drop_type, created_at
          from ${DROPS_TABLE}
          where id in (:dropIds)
            and drop_type in ('${DropType.PARTICIPATORY}', '${DropType.WINNER}')
        ),
        target_waves as (
          select distinct wave_id
          from target_submissions
        ),
        vote_counts as (
          select
            drop_id,
            sum(votes) as tally,
            count(distinct voter_id) as voters_count
          from ${DROP_VOTER_STATE_TABLE}
          where drop_id in (:dropIds)
            and votes <> 0
          group by 1
        ),
        winner_voter_counts as (
          select drop_id, count(*) as voters_count
          from ${WINNER_DROP_VOTER_VOTES_TABLE}
          where drop_id in (:dropIds)
            and votes <> 0
          group by 1
        ),
        decision_counts as (
          select wave_id, count(*) as decisions_done
          from ${WAVES_DECISIONS_TABLE}
          where wave_id in (select wave_id from target_waves)
          group by 1
        ),
        realtime_ranks as (
          select drop_id, rnk
          from (
            select
              d.id as drop_id,
              rank() over (
                partition by d.wave_id
                order by ifnull(r.vote, 0) desc,
                  ifnull(r.last_increased, d.created_at) asc
              ) as rnk
            from ${DROPS_TABLE} d
            left join ${DROP_RANK_TABLE} r on r.drop_id = d.id
            where d.drop_type = '${DropType.PARTICIPATORY}'
              and d.wave_id in (select wave_id from target_waves)
          ) ranked
          where drop_id in (:dropIds)
        ),
        weighted_ranks as (
          select drop_id, rnk
          from (
            select
              d.id as drop_id,
              rank() over (
                partition by d.wave_id
                order by cast(ifnull(lb.vote, 0) as signed) desc,
                  cast(ifnull(lb.timestamp, d.created_at) as signed) asc
              ) as rnk
            from ${DROPS_TABLE} d
            join ${WAVES_TABLE} w on w.id = d.wave_id
            left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} lb on lb.drop_id = d.id
            where d.drop_type = '${DropType.PARTICIPATORY}'
              and d.wave_id in (select wave_id from target_waves)
              and w.time_lock_ms is not null
              and w.time_lock_ms > 0
          ) ranked
          where drop_id in (:dropIds)
        )
        select
          t.id as drop_id,
          t.drop_type as status,
          case
            when t.drop_type = '${DropType.WINNER}' then 0
            when w.type <> 'CHAT'
              and (w.voting_period_start is null or w.voting_period_start < :now)
              and (w.voting_period_end is null or w.voting_period_end > :now)
              and not (
                w.type = 'APPROVE'
                and w.max_winners is not null
                and coalesce(dc.decisions_done, 0) >= w.max_winners
              )
            then 1
            else 0
          end as is_open,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
            else coalesce(vc.tally, 0)
          end as total_votes_given,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
            else coalesce(lb.vote, vc.tally, 0)
          end as current_calculated_vote,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wd.final_vote, 0)
            else coalesce(lb.vote_on_decision_time, vc.tally, 0)
          end as predicted_final_vote,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wvc.voters_count, 0)
            else coalesce(vc.voters_count, 0)
          end as voters_count,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wd.ranking, 0)
            else coalesce(wr.rnk, rr.rnk, 0)
          end as place,
          w.forbid_negative_votes as forbid_negative_votes
        from target_submissions t
        join ${WAVES_TABLE} w on w.id = t.wave_id
        left join vote_counts vc on vc.drop_id = t.id
        left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} lb on lb.drop_id = t.id
        left join realtime_ranks rr on rr.drop_id = t.id
        left join weighted_ranks wr on wr.drop_id = t.id
        left join ${WAVES_DECISION_WINNER_DROPS_TABLE} wd on wd.drop_id = t.id
        left join winner_voter_counts wvc on wvc.drop_id = t.id
        left join decision_counts dc on dc.wave_id = t.wave_id
      `,
        { dropIds, now },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => {
          acc[row.drop_id] = {
            ...row,
            is_open: row.is_open === true || Number(row.is_open) === 1,
            forbid_negative_votes:
              row.forbid_negative_votes === true ||
              Number(row.forbid_negative_votes) === 1,
            total_votes_given: Number(row.total_votes_given),
            current_calculated_vote: Number(row.current_calculated_vote),
            predicted_final_vote: Number(row.predicted_final_vote),
            voters_count: Number(row.voters_count),
            place: Number(row.place)
          };
          return acc;
        },
        {} as Record<string, DropSubmissionVotingSummary>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getDropV2SubmissionVotingSummaries`
      );
    }
  }

  public async getWeightedDropRates(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, { current: number; prediction: number }>> {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWeightedDropRates`);
    const sql = `
      select drop_id, vote as vote, vote_on_decision_time as prediction
      from ${WAVE_LEADERBOARD_ENTRIES_TABLE}
      where drop_id in (:dropIds)
    `;
    const result = await this.db
      .execute<{
        drop_id: string;
        vote: number;
        prediction: number;
      }>(sql, { dropIds }, { wrappedConnection: ctx.connection })
      .then((result) =>
        result.reduce(
          (acc, it) => ({
            ...acc,
            [it.drop_id]: { current: it.vote, prediction: it.prediction }
          }),
          {} as Record<string, { current: number; prediction: number }>
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
                                WHERE id IN (:dropIds)),
               all_ranks AS (
                   SELECT d.id  AS drop_id,
                          RANK() OVER (
                              PARTITION BY d.wave_id
                              ORDER BY IFNULL(r.vote, 0) DESC,
                                  IFNULL(r.last_increased, d.created_at)
                              ) AS rnk
                   FROM ${DROPS_TABLE} d
                            LEFT JOIN ${DROP_RANK_TABLE} r
                                      ON r.drop_id = d.id
                   WHERE d.drop_type = 'PARTICIPATORY'
                     AND d.wave_id IN (SELECT wave_id FROM needed_waves)
               )
          SELECT * FROM all_ranks WHERE drop_id IN (:dropIds)
      `,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(
      `${this.constructor.name}->getParticipationDropsRealtimeRanks`
    );
    return results.reduce(
      (acc, red) => {
        acc[red.drop_id] = red.rnk;
        return acc;
      },
      {} as Record<string, number>
    );
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
    return results.reduce(
      (acc, red) => {
        acc[red.drop_id] = red.rnk;
        return acc;
      },
      {} as Record<string, number>
    );
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
    return results.reduce(
      (acc, red) => {
        acc[red.drop_id] = red.raters_count;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async getWinningDropsTopRaters(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WinnerDropVoterVoteEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getWinningDropsTopRaters`);
    const sql = `
      with ranked_voters as (
        select
          voter_id,
          drop_id,
          votes,
          wave_id,
          row_number() over (partition by drop_id order by votes desc) as rn
        from ${WINNER_DROP_VOTER_VOTES_TABLE}
        where drop_id in (:dropIds) and votes <> 0
      )
      select voter_id, drop_id, votes, wave_id
      from ranked_voters
      where rn <= 5
    `;
    const results = await this.db.execute<WinnerDropVoterVoteEntity>(
      sql,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getWinningDropsTopRaters`);
    return results.reduce(
      (acc, it) => {
        if (!acc[it.drop_id]) {
          acc[it.drop_id] = [];
        }
        acc[it.drop_id].push(it);
        return acc;
      },
      {} as Record<string, WinnerDropVoterVoteEntity[]>
    );
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
    return results.reduce(
      (acc, red) => {
        acc[red.drop_id] = red.votes;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  async getCurrentVoterStatesForDrops(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<WinnerDropVoterVoteEntity[]> {
    if (!dropIds.length) {
      return [];
    }
    ctx.timer?.start(`${this.constructor.name}->getCurrentVoterStatesForDrops`);
    try {
      return await this.db.execute<WinnerDropVoterVoteEntity>(
        `
        select
          voter_id,
          drop_id,
          votes,
          wave_id
        from ${DROP_VOTER_STATE_TABLE}
        where drop_id in (:dropIds)
          and votes <> 0
      `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getCurrentVoterStatesForDrops`
      );
    }
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

  async snapShotDropsRealVoteInTimeBasedOnRank(
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

  async getDropsInNeedOfLeaderboardUpdate(ctx: RequestContext): Promise<
    {
      drop_id: string;
      time_lock_ms: number;
      wave_id: string;
      next_decision_time: number | null;
    }[]
  > {
    return this.db.execute<{
      drop_id: string;
      time_lock_ms: number;
      wave_id: string;
      next_decision_time: number | null;
    }>(
      `select lvc.drop_id as drop_id, lvc.time_lock_ms as time_lock_ms, lvc.wave_id as wave_id, lvc.next_decision_time as next_decision_time
from (select d.drop_id, d.wave_id as wave_id, w.time_lock_ms as time_lock_ms, w.next_decision_time, max(d.timestamp) as timestamp
      from ${DROP_REAL_VOTE_IN_TIME_TABLE} d
               join ${WAVES_TABLE} w
                    on w.id = d.wave_id and w.time_lock_ms is not null and w.time_lock_ms > 0
               join ${DROPS_TABLE} dr on d.drop_id = dr.id
               where dr.drop_type = '${DropType.PARTICIPATORY}'
      group by 1, 2, 3, 4) lvc
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
                     group by drv_2_i.drop_id
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
    const states = await this.db.execute<DropRealVoteInTimeWithoutId>(
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
          insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id, wave_id, timestamp, vote, vote_on_decision_time)
          values (:drop_id, :wave_id, :timestamp, :vote, :vote_on_decision_time)
          on duplicate key update vote = :vote, vote_on_decision_time = :vote_on_decision_time, timestamp = :timestamp
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
        res.reduce(
          (acc, it) => {
            acc[it.drop_id] = it.timestamp;
            return acc;
          },
          {} as Record<string, number>
        )
      );
  }

  async insertWinnerDropsVoterVotes(
    entities: WinnerDropVoterVoteEntity[],
    ctx: RequestContext
  ) {
    if (!entities.length) {
      return;
    }
    const sql = `
        insert into ${WINNER_DROP_VOTER_VOTES_TABLE} (voter_id, drop_id, votes, wave_id)
          values ${entities
            .map(
              (entity) =>
                `(${mysql.escape(entity.voter_id)}, ${mysql.escape(
                  entity.drop_id
                )}, ${mysql.escape(entity.votes)}, ${mysql.escape(
                  entity.wave_id
                )})`
            )
            .join(', ')}
      `;
    await this.db.execute(sql, undefined, {
      wrappedConnection: ctx.connection
    });
  }

  public async snapshotDropVotersRealVoteInTimeBasedOnVoterState(
    params: { dropId: string; voterId: string; now: number },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertDropRealVoterVoteInTime`);
    await this.db.execute(
      `
      insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (voter_id, drop_id, vote, wave_id, timestamp) 
      select voter_id, drop_id, votes, wave_id, :now from ${DROP_VOTER_STATE_TABLE} where drop_id = :dropId and voter_id = :voterId`,
      params,
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

  async getAllVoteChangeLogsForGivenDropsInTimeframe(
    params: { timeLockStart: number; dropIds: string[] },
    ctx: RequestContext
  ): Promise<
    Record<
      string,
      Record<
        string,
        [{ drop_id: string; voter_id: string; vote: number; timestamp: number }]
      >
    >
  > {
    if (params.dropIds.length === 0) {
      return {};
    }
    const dbResults = await this.db
      .execute<{
        voter_id: string;
        drop_id: string;
        vote: number;
        created_at_sec: number;
      }>(
        `
      with transf_ac_logs as (select profile_id                        as              voter_id,
                               target_id                         as              drop_id,
                               JSON_UNQUOTE(JSON_EXTRACT(contents, '$.oldVote')) old_vote,
                               JSON_UNQUOTE(JSON_EXTRACT(contents, '$.newVote')) new_vote,
                               UNIX_TIMESTAMP(created_at) as              created_at_sec
                        from profile_activity_logs
                        where type = 'DROP_VOTE_EDIT'
                          and target_id in
                              (:dropIds))
        select voter_id, drop_id, new_vote as vote, created_at_sec from transf_ac_logs where old_vote <> new_vote
    `,
        { dropIds: params.dropIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res
          .map((it) => ({
            drop_id: it.drop_id,
            vote: +it.vote,
            voter_id: it.voter_id,
            timestamp: it.created_at_sec * 1000
          }))
          .sort((a, d) => a.timestamp - d.timestamp)
      );
    return dbResults.reduce(
      (byDropAcc, byDropIt) => {
        const dropId = byDropIt.drop_id;
        const voterId = byDropIt.voter_id;
        const timestamp = byDropIt.timestamp;
        if (!byDropAcc[dropId]) {
          byDropAcc[dropId] = {};
        }
        if (!byDropAcc[dropId][voterId]) {
          byDropAcc[dropId][voterId] = [byDropIt];
        } else if (timestamp > params.timeLockStart) {
          byDropAcc[dropId][voterId].push(byDropIt);
        } else {
          byDropAcc[dropId][voterId] = [byDropIt];
        }
        return byDropAcc;
      },
      {} as Record<
        string,
        Record<
          string,
          [
            {
              drop_id: string;
              voter_id: string;
              vote: number;
              timestamp: number;
            }
          ]
        >
      >
    );
  }
}

export type NewDropVoteCreditSpending = Omit<DropVoteCreditSpending, 'id'>;
export type NewDropVoterState = Omit<DropVoterStateEntity, 'id'>;

export const dropVotingDb = new DropVotingDb(dbSupplier);
