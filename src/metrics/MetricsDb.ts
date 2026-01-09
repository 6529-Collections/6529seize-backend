import { METRIC_ROLLUP_HOUR_TABLE } from '../constants';
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
}

export const metricsDb = new MetricsDb(dbSupplier);
