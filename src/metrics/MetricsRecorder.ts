import { metricsDb, MetricsDb } from './MetricsDb';
import { MetricRollupHourMetric } from '../entities/IMetricRollupHour';
import { RequestContext } from '../request.context';

export class MetricsRecorder {
  constructor(private readonly metricsDb: MetricsDb) {}

  async recordDrop(ctx: RequestContext) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.DROP,
        event_count: 1
      },
      ctx
    );
  }
}

export const metricsRecorder = new MetricsRecorder(metricsDb);
