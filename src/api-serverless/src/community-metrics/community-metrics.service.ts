import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { ApiCommunityMetricSample } from '../generated/models/ApiCommunityMetricSample';
import {
  MetricGroupInterval,
  MetricRollupHourGroup,
  MetricRollupHourLatest,
  MetricsDb,
  metricsDb
} from '../../../metrics/MetricsDb';
import { RequestContext } from '../../../request.context';
import { Time } from '../../../time';
import { MetricRollupHourMetric } from '../../../entities/IMetricRollupHour';
import { numbers } from '../../../numbers';

export class CommunityMetricsService {
  constructor(private readonly metricsDb: MetricsDb) {}

  async getCommunityMetrics(
    interval: MetricGroupInterval,
    ctx: RequestContext
  ): Promise<ApiCommunityMetrics> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getCommunityMetrics`);
      const periodEnd = Time.latestUtcMidnight();
      const periodStart =
        interval === 'DAY' ? periodEnd.minusDays(1) : periodEnd.minusWeeks(1);
      const olderPeriodEnd = periodStart;
      const olderPeriodStart =
        interval === 'DAY'
          ? olderPeriodEnd.minusDays(1)
          : olderPeriodEnd.minusWeeks(1);
      if (periodStart.gte(periodEnd)) {
        throw new Error('Invalid metrics period');
      }
      const [olderGroups, newerGroups] = await Promise.all([
        this.metricsDb.getMetricGroups(interval, olderPeriodEnd, ctx),
        this.metricsDb.getMetricGroups(interval, periodEnd, ctx)
      ]);
      const [olderNetworkTdh, newerNetworkTdh] = await Promise.all([
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.NETWORK_TDH,
          olderPeriodStart,
          olderPeriodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.NETWORK_TDH,
          periodStart,
          periodEnd,
          ctx
        )
      ]);
      return {
        drops_created: {
          older: this.toMetricSample(
            MetricRollupHourMetric.DROP,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricSample(
            MetricRollupHourMetric.DROP,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        distinct_droppers: {
          older: this.toMetricCountSample(
            MetricRollupHourMetric.DROPPER_DROP,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricCountSample(
            MetricRollupHourMetric.DROPPER_DROP,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        main_stage_submissions: {
          older: this.toMetricSample(
            MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricSample(
            MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        main_stage_distinct_voters: {
          older: this.toMetricCountSample(
            MetricRollupHourMetric.MAIN_STAGE_VOTE,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricCountSample(
            MetricRollupHourMetric.MAIN_STAGE_VOTE,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        main_stage_votes: {
          older: this.toMetricSumSample(
            MetricRollupHourMetric.MAIN_STAGE_VOTE,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricSumSample(
            MetricRollupHourMetric.MAIN_STAGE_VOTE,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        network_tdh: {
          older: this.toLatestMetricSample(
            olderNetworkTdh,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toLatestMetricSample(
            newerNetworkTdh,
            periodStart,
            periodEnd
          )
        }
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getCommunityMetrics`);
    }
  }

  private toMetricSample(
    metricToGet: MetricRollupHourMetric,
    groups: MetricRollupHourGroup[],
    fallbackStart: Time,
    fallbackEnd: Time
  ): ApiCommunityMetricSample {
    const group = groups.find((row) => row.metric === metricToGet);
    if (!group) {
      return {
        period_start: fallbackStart.toMillis(),
        period_end: fallbackEnd.toMillis(),
        event_count: 0,
        value_count: 0
      };
    }
    return {
      period_start: numbers.parseIntOrThrow(group.period_start),
      period_end: numbers.parseIntOrThrow(group.period_end),
      event_count: numbers.parseIntOrThrow(group.event_count),
      value_count: numbers.parseNumberOrThrow(group.value_sum)
    };
  }

  private toMetricCountSample(
    metricToGet: MetricRollupHourMetric,
    groups: MetricRollupHourGroup[],
    fallbackStart: Time,
    fallbackEnd: Time
  ): ApiCommunityMetricSample {
    const count = groups.filter((row) => row.metric === metricToGet).length;
    return {
      period_start: fallbackStart.toMillis(),
      period_end: fallbackEnd.toMillis(),
      event_count: count,
      value_count: count
    };
  }

  private toMetricSumSample(
    metricToGet: MetricRollupHourMetric,
    groups: MetricRollupHourGroup[],
    fallbackStart: Time,
    fallbackEnd: Time
  ): ApiCommunityMetricSample {
    const metricGroups = groups.filter((row) => row.metric === metricToGet);
    if (!metricGroups.length) {
      return {
        period_start: fallbackStart.toMillis(),
        period_end: fallbackEnd.toMillis(),
        event_count: 0,
        value_count: 0
      };
    }
    const eventCount = metricGroups.reduce(
      (acc, row) => acc + numbers.parseIntOrThrow(row.event_count),
      0
    );
    const valueSum = metricGroups.reduce(
      (acc, row) => acc + numbers.parseNumberOrThrow(row.value_sum),
      0
    );
    return {
      period_start: fallbackStart.toMillis(),
      period_end: fallbackEnd.toMillis(),
      event_count: eventCount,
      value_count: valueSum
    };
  }

  private toLatestMetricSample(
    latest: MetricRollupHourLatest | null,
    fallbackStart: Time,
    fallbackEnd: Time
  ): ApiCommunityMetricSample {
    if (!latest) {
      return {
        period_start: fallbackStart.toMillis(),
        period_end: fallbackEnd.toMillis(),
        event_count: 0,
        value_count: 0
      };
    }
    return {
      period_start: fallbackStart.toMillis(),
      period_end: fallbackEnd.toMillis(),
      event_count: numbers.parseIntOrThrow(latest.event_count),
      value_count: numbers.parseNumberOrThrow(latest.value_sum)
    };
  }
}

export const communityMetricsService = new CommunityMetricsService(metricsDb);
