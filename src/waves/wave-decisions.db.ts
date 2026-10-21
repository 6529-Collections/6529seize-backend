import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import { collections } from '../collections';
import {
  DROPS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_TABLE
} from '../constants';
import {
  WaveDecisionEntity,
  WaveDecisionWinnerDropEntity,
  WaveDecisionWinnerPrize
} from '../entities/IWaveDecision';
import { RequestContext } from '../request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';

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
        from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wdwd
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
      from ${legacyGetView(WAVES_DECISIONS_TABLE)} wd
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
      from ${legacyGetView(WAVES_DECISIONS_TABLE)} wd
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
      from ${legacyGetView(WAVES_DECISION_WINNER_DROPS_TABLE)} wdwd
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
}

export const waveDecisionsDb = new WaveDecisionsDb(dbSupplier);
