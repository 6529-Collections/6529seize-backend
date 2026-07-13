import { collections } from '../collections';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROPS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_TABLE
} from '../constants';
import { DropType } from '../entities/IDrop';
import {
  WaveDecisionPauseEntity,
  WaveDecisionStrategy
} from '../entities/IWave';
import {
  WaveDecisionEntity,
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';
import { RequestContext } from '../request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { Time } from '../time';

const mysql = require('mysql');

export class WaveDecisionsDb extends LazyDbAccessCompatibleService {
  private getAdditionalActionPromiseWinnerFilterSql(params: {
    is_additional_action_promised?: boolean | null;
  }): string {
    if (params.is_additional_action_promised == null) {
      return '';
    }
    return `
      and exists (
        select 1
        from ${WAVES_DECISION_WINNER_DROPS_TABLE} wdwd
        join ${DROPS_TABLE} d
          on d.id = wdwd.drop_id
          and d.is_additional_action_promised = :is_additional_action_promised
        where wdwd.wave_id = wd.wave_id
          and wdwd.decision_time = wd.decision_time
      )
    `;
  }

  private getAdditionalActionPromiseSqlParams(params: {
    is_additional_action_promised?: boolean | null;
  }): { is_additional_action_promised?: boolean } {
    if (params.is_additional_action_promised == null) {
      return {};
    }
    return {
      is_additional_action_promised: params.is_additional_action_promised
    };
  }

  private getAdditionalActionPromiseWinnerJoinSql(params: {
    is_additional_action_promised?: boolean | null;
  }): string {
    if (params.is_additional_action_promised == null) {
      return '';
    }
    return `
      join ${DROPS_TABLE} d
        on d.id = wdwd.drop_id
        and d.is_additional_action_promised = :is_additional_action_promised
    `;
  }

  public async insertDecision(
    decision: WaveDecisionEntity,
    ctx: RequestContext
  ) {
    ctx?.timer?.start(`${this.constructor.name}->insertDecision`);
    const connection = ctx.connection;
    if (!connection) {
      throw new Error(`Wave decisions can only be saved in a transaction`);
    }
    await this.db.execute(
      `
      insert into ${WAVES_DECISIONS_TABLE} (decision_time, wave_id)
      values (:decision_time, :wave_id)
    `,
      decision,
      { wrappedConnection: ctx.connection }
    );
    ctx?.timer?.stop(`${this.constructor.name}->insertDecision`);
  }

  public async insertDecisionIfMissing(
    decision: WaveDecisionEntity,
    ctx: RequestContext
  ) {
    ctx?.timer?.start(`${this.constructor.name}->insertDecisionIfMissing`);
    const connection = ctx.connection;
    if (!connection) {
      throw new Error(`Wave decisions can only be saved in a transaction`);
    }
    await this.db.execute(
      `
      insert ignore into ${WAVES_DECISIONS_TABLE} (decision_time, wave_id)
      values (:decision_time, :wave_id)
    `,
      decision,
      { wrappedConnection: ctx.connection }
    );
    ctx?.timer?.stop(`${this.constructor.name}->insertDecisionIfMissing`);
  }

  public async insertDecisionWinners(
    decisionWinners: WaveDecisionWinnerDropEntity[],
    ctx: RequestContext
  ) {
    ctx?.timer?.start(`${this.constructor.name}->insertDecisionWinners`);
    const connection = ctx.connection;
    if (!connection) {
      throw new Error(
        `Wave decision winners can only be saved in a transaction`
      );
    }
    if (decisionWinners.length) {
      const sql = `
          insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (drop_id,
                                                            ranking,
                                                            decision_time,
                                                            prizes,
                                                            wave_id,
                                                            final_vote)
          values ${decisionWinners
            .map(
              (winner) =>
                `(${mysql.escape(winner.drop_id)}, ${mysql.escape(
                  winner.ranking
                )}, ${mysql.escape(winner.decision_time)}, ${mysql.escape(
                  JSON.stringify(winner.prizes)
                )}, ${mysql.escape(winner.wave_id)}, ${mysql.escape(
                  winner.final_vote
                )})`
            )
            .join(', ')}
      `;
      await this.db.execute(sql, undefined, {
        wrappedConnection: ctx.connection
      });
    }
    ctx?.timer?.stop(`${this.constructor.name}->insertDecisionWinners`);
  }

  public async getWavesWithDecisionTimesBeforeGivenTime(
    givenTime: number,
    ctx: RequestContext
  ): Promise<
    {
      wave_id: string;
      latest_decision_time: number | null;
      decisions_strategy: WaveDecisionStrategy;
      time_lock_ms: number | null;
    }[]
  > {
    ctx.timer?.start(`${this.constructor.name}->getWavesLatestDecisionTimes`);
    const result = await this.db
      .execute<{
        wave_id: string;
        latest_decision_time: number | null;
        decisions_strategy: string;
        time_lock_ms: number | null;
      }>(
        `
      select w.id as wave_id, w.time_lock_ms as time_lock_ms, w.decisions_strategy, max(d.decision_time) as latest_decision_time from ${WAVES_TABLE} w
      left join ${WAVES_DECISIONS_TABLE} d on d.wave_id = w.id where w.next_decision_time is not null and w.next_decision_time < :givenTime group by 1, 2, 3
    `,
        { givenTime },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          decisions_strategy: JSON.parse(it.decisions_strategy)
        }))
      );
    ctx.timer?.stop(`${this.constructor.name}->getWavesLatestDecisionTimes`);
    return result;
  }

  async getTopNDropIdsForWaveWithVotes(
    { waveId, n }: { waveId: string; n: number },
    ctx: RequestContext
  ): Promise<{ drop_id: string; vote: number; rank: number }[]> {
    const sql = `
      with x1 as (
        select drv.drop_id, max(drv.timestamp) as timestamp from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv
                                                    join ${DROPS_TABLE} d on d.id = drv.drop_id
                                                    where drv.wave_id = :waveId and d.drop_type = '${DropType.PARTICIPATORY}' group by 1
      )
      select dit.drop_id as drop_id, dit.vote as vote from ${DROP_REAL_VOTE_IN_TIME_TABLE} dit join x1 on x1.drop_id = dit.drop_id and x1.timestamp = dit.timestamp order by dit.vote desc, dit.timestamp desc limit :n
    `;
    return await this.db
      .execute<{
        drop_id: string;
        vote: number;
      }>(sql, { waveId, n }, { wrappedConnection: ctx.connection })
      .then((res) => res.map((it, idx) => ({ ...it, rank: idx + 1 })));
  }

  async updateDropsToWinners(dropIds: string[], ctx: RequestContext) {
    if (!dropIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->updateDropsToWinners`);
    await this.db.execute(
      `update ${DROPS_TABLE} set drop_type = '${DropType.WINNER}' where id in (:dropIds)`,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->updateDropsToWinners`);
  }

  async deleteDropsRanks(dropIds: string[], ctx: RequestContext) {
    if (!dropIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->deleteDropsRanks`);
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->deleteDropsRanks`);
  }

  async updateWavesNextDecisionTime(
    waveId: string,
    decisionTime: number | null,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateWavesNextDecisionTime`);
    await this.db.execute(
      `update ${WAVES_TABLE} set next_decision_time = :decisionTime where id = :waveId`,
      { decisionTime, waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->updateWavesNextDecisionTime`);
  }

  async searchForDecisions(
    param: {
      sort_direction: 'ASC' | 'DESC';
      offset: number;
      wave_id: string;
      limit: number;
      sort: string;
      is_additional_action_promised?: boolean | null;
    },
    ctx: RequestContext
  ): Promise<WaveDecisionEntity[]> {
    ctx.timer?.start(`${this.constructor.name}->searchForDecisions`);
    const additionalActionPromiseFilter =
      this.getAdditionalActionPromiseWinnerFilterSql(param);
    const result = await this.db.execute<WaveDecisionEntity>(
      `
      select wd.*
      from ${WAVES_DECISIONS_TABLE} wd
      where wd.wave_id = :wave_id
        ${additionalActionPromiseFilter}
      order by wd.${param.sort} ${param.sort_direction}
      limit :limit offset :offset`,
      {
        ...param,
        ...this.getAdditionalActionPromiseSqlParams(param)
      },
      {
        wrappedConnection: ctx.connection
      }
    );
    ctx.timer?.stop(`${this.constructor.name}->searchForDecisions`);
    return result;
  }

  async countDecisions(
    params: {
      wave_id: string;
      is_additional_action_promised?: boolean | null;
    },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countDecisions`);
    const additionalActionPromiseFilter =
      this.getAdditionalActionPromiseWinnerFilterSql(params);
    const result = await this.db
      .oneOrNull<{ cnt: number }>(
        `
      select count(*) as cnt
      from ${WAVES_DECISIONS_TABLE} wd
      where wd.wave_id = :wave_id
        ${additionalActionPromiseFilter}`,
        {
          ...params,
          ...this.getAdditionalActionPromiseSqlParams(params)
        },
        {
          wrappedConnection: ctx.connection
        }
      )
      .then((it) => it?.cnt ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->countDecisions`);
    return result;
  }

  async findAllDecisionWinners(
    decisionEntities: WaveDecisionEntity[],
    isAdditionalActionPromised: boolean | null,
    ctx: RequestContext
  ): Promise<WaveDecisionWinnerDropEntity[]> {
    if (!decisionEntities.length) {
      return [];
    }
    ctx.timer?.start(`${this.constructor.name}->findAllDecisionWinners`);
    const waveIds = collections.distinct(
      decisionEntities.map((it) => it.wave_id)
    );
    const decisionTimes = decisionEntities.map((it) => it.decision_time);
    const additionalActionPromiseParams = {
      is_additional_action_promised: isAdditionalActionPromised
    };
    const additionalActionPromiseJoin =
      this.getAdditionalActionPromiseWinnerJoinSql(
        additionalActionPromiseParams
      );
    const result = await this.db
      .execute<
        Omit<WaveDecisionWinnerDropEntity, 'prizes'> & { prizes: string }
      >(
        `
      select wdwd.*
      from ${WAVES_DECISION_WINNER_DROPS_TABLE} wdwd
      ${additionalActionPromiseJoin}
      where wdwd.wave_id in (:waveIds)
        and wdwd.decision_time in (:decisionTimes)
    `,
        {
          waveIds,
          decisionTimes,
          ...this.getAdditionalActionPromiseSqlParams(
            additionalActionPromiseParams
          )
        },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          prizes: JSON.parse(it.prizes) as WaveDecisionWinnerPrize[]
        }))
      );
    ctx.timer?.stop(`${this.constructor.name}->findAllDecisionWinners`);
    return result;
  }

  async findMemeCardIdsByDropIds(
    dropIds: string[],
    mainStageWaveId: string,
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    const timerName = `${this.constructor.name}->findMemeCardIdsByDropIds`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<{
        drop_id: string;
        meme_card_id: number;
      }>(
        `select drop_id, meme_card_id
         from ${WAVES_DECISION_WINNER_DROPS_TABLE}
         where wave_id = :mainStageWaveId
           and drop_id in (:dropIds)
           and meme_card_id is not null`,
        { dropIds, mainStageWaveId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      return rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.drop_id] = Number(row.meme_card_id);
        return acc;
      }, {});
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async setMemeCardIdForDrop(
    dropId: string,
    memeCardId: number,
    mainStageWaveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->setMemeCardIdForDrop`;
    try {
      ctx.timer?.start(timerName);
      await this.db.execute(
        `update ${WAVES_DECISION_WINNER_DROPS_TABLE}
         set meme_card_id = :memeCardId
         where wave_id = :mainStageWaveId
           and drop_id = :dropId`,
        { dropId, memeCardId, mainStageWaveId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async getApproveWinnerCandidates(
    currentTime: number,
    ctx: RequestContext
  ): Promise<
    {
      wave_id: string;
      drop_id: string;
      created_at: number;
      vote: number;
      winning_min_threshold: number;
      time_lock_ms: number | null;
      max_winners: number | null;
      decisions_done: number;
      latest_decision_time: number | null;
    }[]
  > {
    ctx.timer?.start(`${this.constructor.name}->getApproveWinnerCandidates`);
    const result = await this.db.execute<{
      wave_id: string;
      drop_id: string;
      created_at: number;
      vote: number;
      winning_min_threshold: number;
      time_lock_ms: number | null;
      max_winners: number | null;
      decisions_done: number;
      latest_decision_time: number | null;
    }>(
      `
        with last_below_threshold_vote as (
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
            from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv
            join ${WAVES_TABLE} threshold_wave
              on threshold_wave.id = drv.wave_id
              and threshold_wave.type = 'APPROVE'
              and threshold_wave.winning_min_threshold is not null
              and threshold_wave.winning_threshold_min_duration_ms > 0
              and (
                threshold_wave.time_lock_ms is null
                or threshold_wave.time_lock_ms = 0
              )
            where drv.vote < threshold_wave.winning_min_threshold
              and drv.timestamp <= :currentTime
          ) ranked_below_threshold_votes
          where rn = 1
        ),
        current_above_threshold_period as (
          select
            drv.drop_id,
            min(drv.timestamp) as above_threshold_since
          from ${DROP_REAL_VOTE_IN_TIME_TABLE} drv
          join ${WAVES_TABLE} threshold_wave
            on threshold_wave.id = drv.wave_id
            and threshold_wave.type = 'APPROVE'
            and threshold_wave.winning_min_threshold is not null
            and threshold_wave.winning_threshold_min_duration_ms > 0
            and (
              threshold_wave.time_lock_ms is null
              or threshold_wave.time_lock_ms = 0
            )
          left join last_below_threshold_vote lbtv
            on lbtv.drop_id = drv.drop_id
          where drv.vote >= threshold_wave.winning_min_threshold
            and drv.timestamp <= :currentTime
            and (
              lbtv.drop_id is null
              or drv.timestamp > lbtv.timestamp
              or (drv.timestamp = lbtv.timestamp and drv.id > lbtv.id)
            )
          group by drv.drop_id
        ),
        wave_decision_counts as (
          select
            wave_id,
            count(*) as decisions_done,
            max(decision_time) as latest_decision_time
          from ${WAVES_DECISIONS_TABLE}
          group by 1
        )
        select
          d.wave_id as wave_id,
          d.id as drop_id,
          d.created_at as created_at,
          cast(
            case
              when w.time_lock_ms is not null and w.time_lock_ms > 0
                then ifnull(lb.vote, 0)
              else ifnull(r.vote, 0)
            end as signed
          ) as vote,
          w.winning_min_threshold as winning_min_threshold,
          w.time_lock_ms as time_lock_ms,
          w.max_winners as max_winners,
          ifnull(dc.decisions_done, 0) as decisions_done,
          dc.latest_decision_time as latest_decision_time
        from ${DROPS_TABLE} d
        join ${WAVES_TABLE} w
          on w.id = d.wave_id
          and w.type = 'APPROVE'
        left join ${DROP_RANK_TABLE} r
          on r.drop_id = d.id
        left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} lb
          on lb.drop_id = d.id
          and lb.wave_id = d.wave_id
        left join wave_decision_counts dc
          on dc.wave_id = w.id
        left join current_above_threshold_period catp
          on catp.drop_id = d.id
        where d.drop_type = '${DropType.PARTICIPATORY}'
          and w.winning_min_threshold is not null
          and (
            case
              when w.time_lock_ms is not null and w.time_lock_ms > 0
                then ifnull(lb.vote, 0)
              else ifnull(r.vote, 0)
            end
          ) >= w.winning_min_threshold
          and (
            w.winning_threshold_min_duration_ms = 0
            or (
              w.time_lock_ms is not null
              and w.time_lock_ms > 0
              and lb.over_threshold_since_ms is not null
              and lb.over_threshold_since_ms + w.winning_threshold_min_duration_ms <= :currentTime
            )
            or (
              (w.time_lock_ms is null or w.time_lock_ms = 0)
              and catp.above_threshold_since is not null
              and catp.above_threshold_since + w.winning_threshold_min_duration_ms <= :currentTime
            )
          )
          and (
            w.max_winners is null or ifnull(dc.decisions_done, 0) < w.max_winners
          )
          and not exists (
            select 1
            from ${WAVES_DECISION_PAUSES_TABLE} p
            where p.wave_id = w.id
              and :currentTime between p.start_time and p.end_time
          )
        order by d.wave_id asc, d.created_at asc, d.id asc
      `,
      { currentTime },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getApproveWinnerCandidates`);
    return result;
  }

  async getWavePauses(
    waveId: string,
    ctx: RequestContext
  ): Promise<{ start: Time; end: Time }[]> {
    return await this.db
      .execute<WaveDecisionPauseEntity>(
        `select * from ${WAVES_DECISION_PAUSES_TABLE} where wave_id = :waveId`,
        { waveId },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.map((r) => ({
          start: Time.millis(+r.start_time),
          end: Time.millis(+r.end_time)
        }))
      );
  }
}

export const waveDecisionsDb = new WaveDecisionsDb(dbSupplier);
