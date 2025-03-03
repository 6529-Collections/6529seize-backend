import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import {
  WaveDecisionEntity,
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';
import { RequestContext } from '../request.context';
import {
  DROP_RANK_TABLE,
  DROPS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_TABLE
} from '../constants';
import { WaveDecisionStrategy, WaveOutcome } from '../entities/IWave';
import { DropType } from '../entities/IDrop';
import { distinct } from '../helpers';

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
                                                            wave_id)
          values ${decisionWinners
            .map(
              (winner) =>
                `(${mysql.escape(winner.drop_id)}, ${mysql.escape(
                  winner.ranking
                )}, ${mysql.escape(winner.decision_time)}, ${mysql.escape(
                  JSON.stringify(winner.prizes)
                )}, ${mysql.escape(winner.wave_id)})`
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
      outcomes: WaveOutcome[];
    }[]
  > {
    ctx.timer?.start(`${this.constructor.name}->getWavesLatestDecisionTimes`);
    const result = await this.db
      .execute<{
        wave_id: string;
        latest_decision_time: number | null;
        decisions_strategy: string;
        outcomes: string;
      }>(
        `
      select w.id as wave_id, w.decisions_strategy, w.outcomes as outcomes, max(d.decision_time) as latest_decision_time from ${WAVES_TABLE} w
      left join ${WAVES_DECISIONS_TABLE} d on d.wave_id = w.id where w.next_decision_time is not null and w.next_decision_time < :givenTime group by 1, 2, 3
    `,
        { givenTime },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.map((it) => ({
          ...it,
          decisions_strategy: JSON.parse(it.decisions_strategy),
          outcomes: JSON.parse(it.outcomes)
        }))
      );
    ctx.timer?.stop(`${this.constructor.name}->getWavesLatestDecisionTimes`);
    return result;
  }

  async getTopNDropIdsForWave(
    waveId: string,
    n: number,
    ctx: RequestContext
  ): Promise<string[]> {
    const sql = `
    SELECT drop_id
    FROM (select d.id as drop_id,
                 rank() over (partition by d.wave_id order by cast(ifnull(r.vote, 0) as signed) desc , cast(ifnull(r.last_increased, d.created_at) as signed) asc) as rnk
          from ${DROPS_TABLE} d
                   left join ${DROP_RANK_TABLE} r on r.drop_id = d.id and d.wave_id = :waveId
          where d.drop_type = '${DropType.PARTICIPATORY}') drop_ranks 
    order by rnk desc limit :n
  `;
    return await this.db
      .execute<{ drop_id: string }>(
        sql,
        { waveId, n },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it.map((d) => d.drop_id));
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
      select * from wave_decisions where wave_id = :wave_id order by ${param.sort} ${param.sort_direction} limit :limit offset :offset`,
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
      select count(*) as cnt from wave_decisions where wave_id = :waveId`,
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
    const waveIds = distinct(decisionEntities.map((it) => it.wave_id));
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
}

export const waveDecisionsDb = new WaveDecisionsDb(dbSupplier);
