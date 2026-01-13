import {
  MEMES_CONTRACT,
  METRIC_ROLLUP_HOUR_TABLE,
  NFTS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_TABLE
} from '../constants';
import {
  MetricRollupHourEntity,
  MetricRollupHourMetric
} from '../entities/IMetricRollupHour';
import { RequestContext } from '../request.context';
import { Time } from '../time';
import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';

export type MetricRollupHourUpsertParams = {
  metric: MetricRollupHourMetric;
  scope?: string;
  key1?: string;
  key2?: string;
  event_count: number;
  value_sum?: number;
  overwrite?: boolean;
};

export type MetricGroupInterval = 'DAY' | 'WEEK';

export type MetricRollupHourGroup = Omit<
  MetricRollupHourEntity,
  'hour_start'
> & {
  period_start: number;
  period_end: number;
};

export type MetricRollupHourLatest = MetricRollupHourEntity;
export type CommunityMintMetricRow = {
  token_id: number;
  mint_date: number;
  minted: number;
  subscriptions: number;
};

type CommunityMintMetricsQueryParams = {
  page: number;
  page_size: number;
  sort_direction: 'ASC' | 'DESC';
};

export class MetricsDb extends LazyDbAccessCompatibleService {
  public async upsertMetricRollupHour(
    {
      metric,
      scope = 'global',
      key1 = '',
      key2 = '',
      event_count,
      value_sum = event_count,
      overwrite = false
    }: MetricRollupHourUpsertParams,
    ctx: RequestContext
  ) {
    const updateClause = overwrite
      ? `
          event_count = values(event_count),
          value_sum = values(value_sum)
        `
      : `
          event_count = event_count + values(event_count),
          value_sum = value_sum + values(value_sum)
        `;
    ctx.timer?.start(`${this.constructor.name}->upsertMetricRollupHour`);
    await this.db.execute(
      `
        insert into ${METRIC_ROLLUP_HOUR_TABLE}
          (hour_start, metric, scope, key1, key2, event_count, value_sum)
        values
          (
            timestamp(date_format(utc_timestamp(), '%Y-%m-%d %H:00:00')),
            :metric,
            :scope,
            :key1,
            :key2,
            :event_count,
            :value_sum
          )
        on duplicate key update
          ${updateClause}
      `,
      {
        metric,
        scope,
        key1,
        key2,
        event_count,
        value_sum
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertMetricRollupHour`);
  }

  public async getMetricGroups(
    interval: MetricGroupInterval,
    endTime: Time,
    ctx: RequestContext
  ): Promise<MetricRollupHourGroup[]> {
    const days = interval === 'DAY' ? 1 : 7;
    const endTimeMillis = endTime.toMillis();
    try {
      ctx.timer?.start(`${this.constructor.name}->getMetricGroups`);
      return await this.db.execute(
        `
          select
            min(unix_timestamp(hour_start) * 1000) as period_start,
            unix_timestamp(date_add(max(hour_start), interval 1 hour)) * 1000 as period_end,
            metric,
            scope,
            key1,
            key2,
            sum(event_count) as event_count,
            sum(value_sum) as value_sum
          from ${METRIC_ROLLUP_HOUR_TABLE}
          where hour_start >= date_sub(date(from_unixtime(:end_time / 1000)), interval ${days} day)
            and hour_start < date(from_unixtime(:end_time / 1000))
          group by metric, scope, key1, key2
        `,
        {
          end_time: endTimeMillis
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getMetricGroups`);
    }
  }

  public async getLatestMetricSample(
    metric: MetricRollupHourMetric,
    periodStart: Time,
    periodEnd: Time,
    ctx: RequestContext,
    scope = 'global'
  ): Promise<MetricRollupHourLatest | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getLatestMetricSample`);
      return await this.db.oneOrNull<MetricRollupHourLatest>(
        `
          select
            hour_start,
            metric,
            scope,
            key1,
            key2,
            event_count,
            value_sum
          from ${METRIC_ROLLUP_HOUR_TABLE}
          where metric = :metric
            and scope = :scope
            and hour_start >= from_unixtime(:start_time / 1000)
            and hour_start < from_unixtime(:end_time / 1000)
          order by hour_start desc
          limit 1
        `,
        {
          metric,
          scope,
          start_time: periodStart.toMillis(),
          end_time: periodEnd.toMillis()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getLatestMetricSample`);
    }
  }

  public async getCommunityMintMetrics(
    query: CommunityMintMetricsQueryParams,
    ctx: RequestContext
  ): Promise<CommunityMintMetricRow[]> {
    const sortDirection = query.sort_direction === 'ASC' ? 'asc' : 'desc';
    const offset = (query.page - 1) * query.page_size;
    try {
      ctx.timer?.start(`${this.constructor.name}->getCommunityMintMetrics`);
      return await this.db.execute<CommunityMintMetricRow>(
        `
          select
            n.id as token_id,
            unix_timestamp(n.mint_date) * 1000 as mint_date,
            ifnull(r.minters_count, 0) as minted,
            ifnull(s.subscriptions, 0) as subscriptions
          from ${NFTS_TABLE} n
          left join (
            select token_id, sum(token_count) as minters_count
            from ${TRANSACTIONS_TABLE}
            where contract = :contract
              and value > 0
              and from_address in (
                '0x3A3548e060Be10c2614d0a4Cb0c03CC9093fD799',
                '0x0000000000000000000000000000000000000000'
              )
            group by 1
            order by 1
          ) r on r.token_id = n.id
          left join (
            select token_id, sum(redeemed_count) as subscriptions
            from ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
            where contract = :contract
            group by 1
          ) s on s.token_id = n.id
          where n.contract = :contract
          order by n.mint_date ${sortDirection}
          limit :limit
          offset :offset
        `,
        {
          contract: MEMES_CONTRACT,
          limit: query.page_size,
          offset
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getCommunityMintMetrics`);
    }
  }

  public async countCommunityMintMetrics(ctx: RequestContext): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countCommunityMintMetrics`);
      const result = await this.db.oneOrNull<{
        total: number;
      }>(
        `
          select count(*) as total
          from ${NFTS_TABLE}
          where contract = :contract
        `,
        { contract: MEMES_CONTRACT },
        { wrappedConnection: ctx.connection }
      );
      return result?.total ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countCommunityMintMetrics`);
    }
  }
}

export const metricsDb = new MetricsDb(dbSupplier);
