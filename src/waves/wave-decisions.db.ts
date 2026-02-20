import { collections } from '../collections';
import {
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROPS_TABLE,
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
    },
    ctx: RequestContext
  ): Promise<WaveDecisionEntity[]> {
    ctx.timer?.start(`${this.constructor.name}->searchForDecisions`);
    const result = await this.db.execute<WaveDecisionEntity>(
      `
      select * from ${WAVES_DECISIONS_TABLE} where wave_id = :wave_id order by ${param.sort} ${param.sort_direction} limit :limit offset :offset`,
      param,
      {
        wrappedConnection: ctx.connection
      }
    );
    ctx.timer?.stop(`${this.constructor.name}->searchForDecisions`);
    return result;
  }

  async countDecisions(waveId: string, ctx: RequestContext): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countDecisions`);
    const result = await this.db
      .oneOrNull<{ cnt: number }>(
        `
      select count(*) as cnt from ${WAVES_DECISIONS_TABLE} where wave_id = :waveId`,
        { waveId },
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
    const result = await this.db
      .execute<
        Omit<WaveDecisionWinnerDropEntity, 'prizes'> & { prizes: string }
      >(
        `
      select * from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id in (:waveIds) and decision_time in (:decisionTimes)
    `,
        { waveIds, decisionTimes },
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
