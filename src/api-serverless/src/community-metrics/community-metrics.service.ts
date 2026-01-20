import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { ApiCommunityMetricsSeries } from '../generated/models/ApiCommunityMetricsSeries';
import { ApiCommunityMetricSample } from '../generated/models/ApiCommunityMetricSample';
import { ApiMintMetricsPage } from '../generated/models/ApiMintMetricsPage';
import {
  MetricGroupInterval,
  MetricBucketDistinctCountRow,
  MetricBucketSumRow,
  MetricSampleRow,
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

  async getCommunityMetricsSummary(
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
      const [
        olderGroups,
        newerGroups,
        olderNetworkTdh,
        newerNetworkTdh,
        olderMainStageTdh,
        newerMainStageTdh,
        olderConsolidationsFormed,
        newerConsolidationsFormed,
        olderXtdhGranted,
        newerXtdhGranted,
        olderProfileCount,
        newerProfileCount
      ] = await Promise.all([
        this.metricsDb.getMetricGroups(interval, olderPeriodEnd, ctx),
        this.metricsDb.getMetricGroups(interval, periodEnd, ctx),
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
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS,
          olderPeriodStart,
          olderPeriodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS,
          periodStart,
          periodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.CONSOLIDATIONS_FORMED,
          olderPeriodStart,
          olderPeriodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.CONSOLIDATIONS_FORMED,
          periodStart,
          periodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.XTDH_GRANTED,
          olderPeriodStart,
          olderPeriodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.XTDH_GRANTED,
          periodStart,
          periodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.PROFILE_COUNT,
          olderPeriodStart,
          olderPeriodEnd,
          ctx
        ),
        this.metricsDb.getLatestMetricSample(
          MetricRollupHourMetric.PROFILE_COUNT,
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
        },
        tdh_on_main_stage_submissions: {
          older: this.toLatestMetricSample(
            olderMainStageTdh,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toLatestMetricSample(
            newerMainStageTdh,
            periodStart,
            periodEnd
          )
        },
        consolidations_formed: {
          older: this.toLatestMetricSample(
            olderConsolidationsFormed,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toLatestMetricSample(
            newerConsolidationsFormed,
            periodStart,
            periodEnd
          )
        },
        xtdh_granted: {
          older: this.toLatestMetricSample(
            olderXtdhGranted,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toLatestMetricSample(
            newerXtdhGranted,
            periodStart,
            periodEnd
          )
        },
        active_identities: {
          older: this.toMetricCountSample(
            MetricRollupHourMetric.ACTIVE_IDENTITY,
            olderGroups,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toMetricCountSample(
            MetricRollupHourMetric.ACTIVE_IDENTITY,
            newerGroups,
            periodStart,
            periodEnd
          )
        },
        profile_count: {
          older: this.toLatestMetricSample(
            olderProfileCount,
            olderPeriodStart,
            olderPeriodEnd
          ),
          newer: this.toLatestMetricSample(
            newerProfileCount,
            periodStart,
            periodEnd
          )
        }
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getCommunityMetrics`);
    }
  }

  async getCommunityMintMetrics(
    query: MintMetricsQuery,
    ctx: RequestContext
  ): Promise<ApiMintMetricsPage> {
    ctx.timer?.start(`${this.constructor.name}->getCommunityMintMetrics`);
    try {
      const [data, count] = await Promise.all([
        this.metricsDb.getCommunityMintMetrics(query, ctx),
        this.metricsDb.countCommunityMintMetrics(ctx)
      ]);
      return {
        data: data.map((row) => ({
          card: row.token_id,
          mint_time: row.mint_date,
          mints: row.minted,
          subscriptions: row.subscriptions,
          edition_size: row.edition_size,
          unminted: row.unminted
        })),
        count,
        page: query.page,
        next: count > query.page_size * query.page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getCommunityMintMetrics`);
    }
  }

  async getCommunityMetricsSeries(
    query: CommunityMetricsSeriesQuery,
    ctx: RequestContext
  ): Promise<ApiCommunityMetricsSeries> {
    ctx.timer?.start(`${this.constructor.name}->getCommunityMetricsSeries`);
    try {
      const stepMs = Time.days(1).toMillis();
      const stepsStartTimes: number[] = [];
      for (
        let cursor = query.since;
        cursor <= query.to - stepMs;
        cursor += stepMs
      ) {
        stepsStartTimes.push(cursor);
      }

      const seriesEnd = stepsStartTimes[stepsStartTimes.length - 1] + stepMs;
      const seriesStartTime = Time.millis(query.since);
      const seriesEndTime = Time.millis(seriesEnd);

      const sumMetrics = [
        MetricRollupHourMetric.DROP,
        MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
        MetricRollupHourMetric.MAIN_STAGE_VOTE
      ];
      const distinctMetrics = [
        MetricRollupHourMetric.DROPPER_DROP,
        MetricRollupHourMetric.MAIN_STAGE_VOTE,
        MetricRollupHourMetric.ACTIVE_IDENTITY
      ];
      const latestMetrics = [
        MetricRollupHourMetric.NETWORK_TDH,
        MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS,
        MetricRollupHourMetric.CONSOLIDATIONS_FORMED,
        MetricRollupHourMetric.XTDH_GRANTED,
        MetricRollupHourMetric.PROFILE_COUNT
      ];

      const [
        bucketSums,
        bucketDistinctCounts,
        latestSamples,
        latestBeforeSamples
      ] = await Promise.all([
        this.metricsDb.getMetricBucketSums(
          sumMetrics,
          seriesStartTime,
          seriesEndTime,
          stepMs,
          ctx
        ),
        this.metricsDb.getMetricBucketDistinctCounts(
          distinctMetrics,
          seriesStartTime,
          seriesEndTime,
          stepMs,
          ctx
        ),
        this.metricsDb.getMetricSamplesInRange(
          latestMetrics,
          seriesStartTime,
          seriesEndTime,
          ctx
        ),
        this.metricsDb.getLatestMetricSamplesBefore(
          latestMetrics,
          seriesStartTime,
          ctx
        )
      ]);

      const bucketCount = stepsStartTimes.length;
      const dropsCreated = this.fillMetricBuckets(bucketCount, bucketSums, {
        metric: MetricRollupHourMetric.DROP,
        useValueSum: false
      });
      const mainStageSubmissions = this.fillMetricBuckets(
        bucketCount,
        bucketSums,
        {
          metric: MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
          useValueSum: false
        }
      );
      const mainStageVotes = this.fillMetricBuckets(bucketCount, bucketSums, {
        metric: MetricRollupHourMetric.MAIN_STAGE_VOTE,
        useValueSum: true
      });
      const distinctDroppers = this.fillDistinctBuckets(
        bucketCount,
        bucketDistinctCounts,
        MetricRollupHourMetric.DROPPER_DROP
      );
      const mainStageDistinctVoters = this.fillDistinctBuckets(
        bucketCount,
        bucketDistinctCounts,
        MetricRollupHourMetric.MAIN_STAGE_VOTE
      );
      const activeIdentities = this.fillDistinctBuckets(
        bucketCount,
        bucketDistinctCounts,
        MetricRollupHourMetric.ACTIVE_IDENTITY
      );
      const latestSeries = this.fillLatestMetricBuckets(
        bucketCount,
        query.since,
        stepMs,
        latestMetrics,
        latestSamples,
        latestBeforeSamples
      );

      return {
        steps_start_times: stepsStartTimes,
        drops_created: dropsCreated,
        distinct_droppers: distinctDroppers,
        main_stage_submissions: mainStageSubmissions,
        main_stage_distinct_voters: mainStageDistinctVoters,
        main_stage_votes: mainStageVotes,
        network_tdh: latestSeries.get(MetricRollupHourMetric.NETWORK_TDH) ?? [],
        tdh_on_main_stage_submissions:
          latestSeries.get(
            MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS
          ) ?? [],
        consolidations_formed:
          latestSeries.get(MetricRollupHourMetric.CONSOLIDATIONS_FORMED) ?? [],
        xtdh_granted:
          latestSeries.get(MetricRollupHourMetric.XTDH_GRANTED) ?? [],
        active_identities: activeIdentities,
        profile_count:
          latestSeries.get(MetricRollupHourMetric.PROFILE_COUNT) ?? []
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getCommunityMetricsSeries`);
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

  private fillMetricBuckets(
    bucketCount: number,
    rows: MetricBucketSumRow[],
    {
      metric,
      useValueSum
    }: {
      metric: MetricRollupHourMetric;
      useValueSum: boolean;
    }
  ): number[] {
    const buckets = Array.from({ length: bucketCount }, () => 0);
    for (const row of rows) {
      if (row.metric !== metric) {
        continue;
      }
      const bucket = numbers.parseIntOrThrow(row.bucket);
      if (bucket < 0 || bucket >= bucketCount) {
        continue;
      }
      const value = useValueSum
        ? numbers.parseNumberOrThrow(row.value_sum)
        : numbers.parseIntOrThrow(row.event_count);
      buckets[bucket] = value;
    }
    return buckets;
  }

  private fillDistinctBuckets(
    bucketCount: number,
    rows: MetricBucketDistinctCountRow[],
    metric: MetricRollupHourMetric
  ): number[] {
    const buckets = Array.from({ length: bucketCount }, () => 0);
    for (const row of rows) {
      if (row.metric !== metric) {
        continue;
      }
      const bucket = numbers.parseIntOrThrow(row.bucket);
      if (bucket < 0 || bucket >= bucketCount) {
        continue;
      }
      buckets[bucket] = numbers.parseIntOrThrow(row.distinct_count);
    }
    return buckets;
  }

  private fillLatestMetricBuckets(
    bucketCount: number,
    since: number,
    bucketMs: number,
    metrics: MetricRollupHourMetric[],
    rows: MetricSampleRow[],
    latestBeforeRows: MetricSampleRow[]
  ): Map<MetricRollupHourMetric, number[]> {
    const bucketsByMetric = new Map<MetricRollupHourMetric, number[]>();
    const latestByMetric = new Map<MetricRollupHourMetric, number>();
    for (const metric of metrics) {
      bucketsByMetric.set(
        metric,
        Array.from({ length: bucketCount }, () => 0)
      );
      latestByMetric.set(metric, 0);
    }

    for (const row of latestBeforeRows) {
      latestByMetric.set(row.metric, numbers.parseNumberOrThrow(row.value_sum));
    }

    const bucketLatest = new Map<
      MetricRollupHourMetric,
      Map<number, { hourStart: number; value: number }>
    >();
    for (const metric of metrics) {
      bucketLatest.set(metric, new Map());
    }
    for (const row of rows) {
      const hourStart = numbers.parseIntOrThrow(row.hour_start);
      const bucket = Math.floor((hourStart - since) / bucketMs);
      if (bucket < 0 || bucket >= bucketCount) {
        continue;
      }
      const perMetric = bucketLatest.get(row.metric);
      if (!perMetric) {
        continue;
      }
      const value = numbers.parseNumberOrThrow(row.value_sum);
      const existing = perMetric.get(bucket);
      if (!existing || existing.hourStart < hourStart) {
        perMetric.set(bucket, { hourStart, value });
      }
    }

    for (const metric of metrics) {
      const perMetric = bucketLatest.get(metric);
      const values = bucketsByMetric.get(metric);
      if (!perMetric || !values) {
        continue;
      }
      let lastValue = latestByMetric.get(metric) ?? 0;
      for (let bucket = 0; bucket < bucketCount; bucket += 1) {
        const latest = perMetric.get(bucket);
        if (latest) {
          lastValue = latest.value;
        }
        values[bucket] = lastValue;
      }
    }

    return bucketsByMetric;
  }
}

export type MintMetricsQuery = {
  page: number;
  page_size: number;
  sort_direction: 'ASC' | 'DESC';
  sort: 'mint_time';
};

export type CommunityMetricsSeriesQuery = {
  since: number;
  to: number;
};

export const communityMetricsService = new CommunityMetricsService(metricsDb);
