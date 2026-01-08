import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { ApiCommunityMetricSample } from '../generated/models/ApiCommunityMetricSample';
import {
  MetricGroupInterval,
  MetricRollupHourGroup,
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
}

export const communityMetricsService = new CommunityMetricsService(metricsDb);
