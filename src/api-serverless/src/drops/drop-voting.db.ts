import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import { CompetitionRepository } from '@/competitions/competition.repository';
import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  DROP_RANK_TABLE,
  COMPETITIONS_TABLE,
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
import { WaveType } from '@/entities/IWave';
import mysql from 'mysql';

// A pending decision still needs its final snapshot, even after voting ends.
const ONGOING_LEGACY_LEADERBOARD_WAVE_SQL = `(
  w.next_decision_time is not null
  or (w.participation_period_end is null and w.voting_period_end is null)
  or w.participation_period_end > :now
  or w.voting_period_end > :now
)`;

export interface DropVoteSummaryVoter {
  readonly drop_id: string;
  readonly voter_id: string;
  readonly vote: number;
}

export interface DropVoteDistributionRow extends DropVoteSummaryVoter {
  readonly positive_total: number;
  readonly negative_total: number;
}

type DropVoteSummaryVoterDbRow = Omit<DropVoteSummaryVoter, 'vote'> & {
  vote: number | string;
};

type DropVoteDistributionDbRow = DropVoteSummaryVoterDbRow & {
  positive_total: number | string;
  negative_total: number | string;
};

export interface DropSubmissionVotingSummary {
  drop_id: string;
  status: DropType.PARTICIPATORY | DropType.WINNER;
  is_open: boolean;
  over_threshold_since_ms: number | null;
  won_at: number | null;
  total_votes_given: number;
  current_calculated_vote: number;
  predicted_final_vote: number;
  voters_count: number;
  voters_count_available?: boolean;
  place: number;
  forbid_negative_votes: boolean;
}

type DropSubmissionVotingSummaryRow = Omit<
  DropSubmissionVotingSummary,
  'is_open' | 'forbid_negative_votes'
> & {
  is_open: boolean | number;
  forbid_negative_votes: boolean | number;
  wave_type: string;
  winning_min_threshold: number | null;
  time_lock_ms: number | null;
};

export class DropVotingDb extends LazyDbAccessCompatibleService {
  public async getAggregateDropRankVote(
    dropId: string,
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getAggregateDropRankVote`);
    const vote = await this.db
      .oneOrNull<{
        vote: number;
      }>(
        `select vote from ${legacyGetView(DROP_RANK_TABLE)} where drop_id = :dropId`,
        { dropId },
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.vote ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getAggregateDropRankVote`);
    return vote;
  }

  public async getDropVoterStateForDrop(
    param: { voterId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCurrentState`);
    const votes = await this.db
      .oneOrNull<{ votes: number }>(
        `
      select votes from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
      where voter_id = :voterId and drop_id = :drop_id
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.votes ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getCurrentState`);
    return votes;
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
      sum(abs(s.votes)) as credit_spent from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
      join ${legacyGetView(DROPS_TABLE)} d on d.id = s.drop_id and d.drop_type = '${DropType.PARTICIPATORY}'
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

  public async getLargestDropVotes(
    dropIds: readonly string[],
    ctx: RequestContext
  ): Promise<DropVoteSummaryVoter[]> {
    if (!dropIds.length) {
      return [];
    }
    const timerKey = `${this.constructor.name}->getLargestDropVotes`;
    try {
      ctx.timer?.start(timerKey);
      const rows = await this.db.execute<DropVoteSummaryVoterDbRow>(
        `
        with extrema as (
          select
            s.drop_id,
            min(s.votes) as min_vote,
            max(s.votes) as max_vote
          from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
          where s.drop_id in (:dropIds)
          group by s.drop_id
        ),
        eligible_extrema as (
          select e.drop_id, e.min_vote, e.max_vote
          from extrema e
          join ${legacyGetView(DROPS_TABLE)} d on d.id = e.drop_id
          join ${legacyGetView(WAVES_TABLE)} w on w.id = d.wave_id
          where d.drop_type = '${DropType.PARTICIPATORY}'
            and w.type = '${WaveType.RANK}'
            and (e.min_vote <> 0 or e.max_vote <> 0)
        ),
        extreme_voters as (
          select
            e.*,
            (
              select s.voter_id
              from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
              where s.drop_id = e.drop_id and s.votes = e.min_vote
              order by s.voter_id asc
              limit 1
            ) as min_voter_id,
            (
              select s.voter_id
              from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
              where s.drop_id = e.drop_id and s.votes = e.max_vote
              order by s.voter_id asc
              limit 1
            ) as max_voter_id
          from eligible_extrema e
        ),
        selected_extrema as (
          select
            e.*,
            abs(e.min_vote) > abs(e.max_vote)
              or (
                abs(e.min_vote) = abs(e.max_vote)
                and e.min_voter_id < e.max_voter_id
              ) as use_min
          from extreme_voters e
        )
        select
          drop_id,
          if(use_min, min_voter_id, max_voter_id) as voter_id,
          if(use_min, min_vote, max_vote) as vote
        from selected_extrema
      `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => ({ ...row, vote: Number(row.vote) }));
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async getDropVoteDistribution(
    dropId: string,
    ctx: RequestContext
  ): Promise<DropVoteDistributionRow[]> {
    if (!dropId) {
      return [];
    }
    const timerKey = `${this.constructor.name}->getDropVoteDistribution`;
    try {
      ctx.timer?.start(timerKey);
      const rows = await this.db.execute<DropVoteDistributionDbRow>(
        `
        with eligible_drop as (
          select d.id
          from ${legacyGetView(DROPS_TABLE)} d
          join ${legacyGetView(WAVES_TABLE)} w on w.id = d.wave_id
          where d.id = :dropId
            and d.drop_type = '${DropType.PARTICIPATORY}'
            and w.type = '${WaveType.RANK}'
        ),
        totals as (
          select
            sum(case when s.votes > 0 then s.votes else 0 end) as positive_total,
            sum(case when s.votes < 0 then s.votes else 0 end) as negative_total
          from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
          join eligible_drop e on e.id = s.drop_id
          where s.votes <> 0
        ),
        positive_votes as (
          select s.drop_id, s.voter_id, s.votes as vote
          from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
          join eligible_drop e on e.id = s.drop_id
          where s.votes > 0
          order by s.votes desc, s.voter_id asc
          limit 3
        ),
        negative_votes as (
          select s.drop_id, s.voter_id, s.votes as vote
          from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
          join eligible_drop e on e.id = s.drop_id
          where s.votes < 0
          order by s.votes asc, s.voter_id asc
          limit 3
        ),
        top_votes as (
          select drop_id, voter_id, vote from positive_votes
          union all
          select drop_id, voter_id, vote from negative_votes
        )
        select v.drop_id, v.voter_id, v.vote, t.positive_total, t.negative_total
        from top_votes v
        cross join totals t
        order by abs(v.vote) desc, v.voter_id asc
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => ({
        ...row,
        vote: Number(row.vote),
        positive_total: Number(row.positive_total),
        negative_total: Number(row.negative_total)
      }));
    } finally {
      ctx.timer?.stop(timerKey);
    }
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
      from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
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
      const rows = await this.db.execute<DropSubmissionVotingSummaryRow>(
        `
        with target_submissions as (
          select id, wave_id, drop_type, created_at
          from ${legacyGetView(DROPS_TABLE)}
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
          from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
          where drop_id in (:dropIds)
            and votes <> 0
          group by 1
        ),
        winner_voter_counts as (
          select drop_id, count(nullif(votes, 0)) as voters_count
          from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)}
          where drop_id in (:dropIds)
          group by 1
        ),
        decision_counts as (
          select wave_id, count(*) as decisions_done
          from ${legacyGetView(WAVES_DECISIONS_TABLE)}
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
                order by cast(ifnull(r.vote, 0) as signed) desc,
                  ifnull(r.last_increased, d.created_at) asc
              ) as rnk
            from ${legacyGetView(DROPS_TABLE)} d
            left join ${legacyGetView(DROP_RANK_TABLE)} r on r.drop_id = d.id
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
            from ${legacyGetView(DROPS_TABLE)} d
            join ${legacyGetView(WAVES_TABLE)} w on w.id = d.wave_id
            left join ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)} lb on lb.drop_id = d.id
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
          w.type as wave_type,
          w.winning_min_threshold as winning_min_threshold,
          w.time_lock_ms as time_lock_ms,
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
            when t.drop_type = '${DropType.WINNER}' then null
            when w.type = 'APPROVE'
              and w.time_lock_ms is not null
              and w.time_lock_ms > 0
            then lb.over_threshold_since_ms
            else null
          end as over_threshold_since_ms,
          case
            when t.drop_type = '${DropType.WINNER}' then wd.decision_time
            else null
          end as won_at,
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
          (t.drop_type <> '${DropType.WINNER}' or wvc.drop_id is not null) as voters_count_available,
          case
            when t.drop_type = '${DropType.WINNER}' then coalesce(wd.ranking, 0)
            else coalesce(wr.rnk, rr.rnk, 0)
          end as place,
          w.forbid_negative_votes as forbid_negative_votes
        from target_submissions t
        join ${legacyGetView(WAVES_TABLE)} w on w.id = t.wave_id
        left join vote_counts vc on vc.drop_id = t.id
        left join ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)} lb on lb.drop_id = t.id
        left join realtime_ranks rr on rr.drop_id = t.id
        left join weighted_ranks wr on wr.drop_id = t.id
        left join ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wd on wd.drop_id = t.id
        left join winner_voter_counts wvc on wvc.drop_id = t.id
        left join decision_counts dc on dc.wave_id = t.wave_id
      `,
        { dropIds, now },
        { wrappedConnection: ctx.connection }
      );
      const overThresholdSinceByDropId =
        await this.getOverThresholdSinceByDropId(
          this.getOverThresholdCandidateDropIds(rows),
          now,
          ctx
        );
      return rows.reduce(
        (acc, row) => {
          const cachedOverThresholdSinceMs =
            row.over_threshold_since_ms == null
              ? null
              : Number(row.over_threshold_since_ms);
          acc[row.drop_id] = {
            drop_id: row.drop_id,
            status: row.status,
            is_open: row.is_open === true || Number(row.is_open) === 1,
            over_threshold_since_ms:
              overThresholdSinceByDropId[row.drop_id] ??
              cachedOverThresholdSinceMs,
            won_at:
              row.won_at === null || row.won_at === undefined
                ? null
                : Number(row.won_at),
            forbid_negative_votes:
              row.forbid_negative_votes === true ||
              Number(row.forbid_negative_votes) === 1,
            total_votes_given: Number(row.total_votes_given),
            current_calculated_vote: Number(row.current_calculated_vote),
            predicted_final_vote: Number(row.predicted_final_vote),
            voters_count: Number(row.voters_count),
            voters_count_available: Boolean(Number(row.voters_count_available)),
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

  private getOverThresholdCandidateDropIds(
    rows: DropSubmissionVotingSummaryRow[]
  ): string[] {
    return rows
      .filter(
        (row) =>
          row.status === DropType.PARTICIPATORY &&
          row.wave_type === 'APPROVE' &&
          row.winning_min_threshold !== null &&
          (row.time_lock_ms === null || Number(row.time_lock_ms) === 0) &&
          Number(row.total_votes_given) >= Number(row.winning_min_threshold)
      )
      .map((row) => row.drop_id);
  }

  private async getOverThresholdSinceByDropId(
    dropIds: string[],
    now: number,
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getOverThresholdSinceByDropId`);
    try {
      const rows = await this.db.execute<{
        drop_id: string;
        over_threshold_since_ms: number;
      }>(
        `
        with threshold_drops as (
          select
            d.id as drop_id,
            d.wave_id,
            w.winning_min_threshold
          from ${legacyGetView(DROPS_TABLE)} d
          join ${legacyGetView(WAVES_TABLE)} w
            on w.id = d.wave_id
          where d.id in (:dropIds)
            and d.drop_type = '${DropType.PARTICIPATORY}'
            and w.type = 'APPROVE'
            and w.winning_min_threshold is not null
            and (w.time_lock_ms is null or w.time_lock_ms = 0)
        ),
        last_below_threshold_vote as (
          select
            drop_id,
            timestamp,
            id
          from (
            select
              drv.drop_id,
              drv.timestamp,
              drv.id,
              row_number() over (
                partition by drv.drop_id
                order by drv.timestamp desc, drv.id desc
              ) as rn
            from threshold_drops td
            join ${legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)} drv
              on drv.drop_id = td.drop_id
            where drv.vote < td.winning_min_threshold
              and drv.timestamp <= :now
          ) ranked_below_threshold_votes
          where rn = 1
        ),
        current_above_threshold_period as (
          select
            drv.drop_id,
            min(drv.timestamp) as over_threshold_since_ms
          from threshold_drops td
          join ${legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)} drv
            on drv.drop_id = td.drop_id
          left join last_below_threshold_vote lbtv
            on lbtv.drop_id = drv.drop_id
          where drv.vote >= td.winning_min_threshold
            and drv.timestamp <= :now
            and (
              lbtv.drop_id is null
              or drv.timestamp > lbtv.timestamp
              or (drv.timestamp = lbtv.timestamp and drv.id > lbtv.id)
            )
          group by drv.drop_id
        )
        select drop_id, over_threshold_since_ms
        from current_above_threshold_period
      `,
        { dropIds, now },
        { wrappedConnection: ctx.connection }
      );
      return rows.reduce(
        (acc, row) => ({
          ...acc,
          [row.drop_id]: Number(row.over_threshold_since_ms)
        }),
        {} as Record<string, number>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getOverThresholdSinceByDropId`
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
      from ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)}
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
      select s.wave_id, sum(abs(s.votes)) as total_votes from ${legacyGetView(DROP_VOTER_STATE_TABLE)} s
      join ${legacyGetView(DROPS_TABLE)} d on d.id = s.drop_id and d.drop_type = '${DropType.PARTICIPATORY}'
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
  select drop_id, sum(votes) as total_votes from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
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
        from ${legacyGetView(DROP_VOTER_STATE_TABLE)}
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
                                FROM ${legacyGetView(DROPS_TABLE)}
                                WHERE id IN (:dropIds)),
               all_ranks AS (
                   SELECT d.id  AS drop_id,
                          RANK() OVER (
                              PARTITION BY d.wave_id
                              ORDER BY CAST(IFNULL(r.vote, 0) AS SIGNED) DESC,
                                  IFNULL(r.last_increased, d.created_at)
                              ) AS rnk
                   FROM ${legacyGetView(DROPS_TABLE)} d
                            LEFT JOIN ${legacyGetView(DROP_RANK_TABLE)} r
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
          from ${legacyGetView(DROPS_TABLE)} d
                   join ${legacyGetView(WAVES_TABLE)} w on w.id = d.wave_id
                   left join ${legacyGetView(WAVE_LEADERBOARD_ENTRIES_TABLE)} r on r.drop_id = d.id
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
    const sql = `select drop_id, count(nullif(votes, 0)) as raters_count from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)} where drop_id in (:dropIds) group by 1`;
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
        from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)}
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
    const sql = `select drop_id, votes from ${legacyGetView(WINNER_DROP_VOTER_VOTES_TABLE)} where drop_id in (:dropIds) and voter_id = :voterId and votes <> 0`;
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
}

export type NewDropVoteCreditSpending = Omit<DropVoteCreditSpending, 'id'>;
export type NewDropVoterState = Omit<DropVoterStateEntity, 'id'>;

export const dropVotingDb = new DropVotingDb(dbSupplier);
