import { metricsDb, MetricsDb } from './MetricsDb';
import { MetricRollupHourMetric } from '../entities/IMetricRollupHour';
import { DropType } from '../entities/IDrop';
import { env } from '../env';
import { RequestContext } from '../request.context';

export class MetricsRecorder {
  constructor(private readonly metricsDb: MetricsDb) {}

  async recordDrop(
    {
      identityId,
      waveId,
      dropType
    }: { identityId: string; waveId: string; dropType: DropType },
    ctx: RequestContext
  ) {
    const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
    const promises = [
      this.metricsDb.upsertMetricRollupHour(
        {
          metric: MetricRollupHourMetric.DROP,
          event_count: 1
        },
        ctx
      ),
      this.metricsDb.upsertMetricRollupHour(
        {
          metric: MetricRollupHourMetric.DROPPER_DROP,
          scope: identityId,
          event_count: 1
        },
        ctx
      )
    ];
    if (
      mainStageWaveId &&
      waveId === mainStageWaveId &&
      dropType === DropType.PARTICIPATORY
    ) {
      promises.push(
        this.metricsDb.upsertMetricRollupHour(
          {
            metric: MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
            event_count: 1
          },
          ctx
        )
      );
    }
    await Promise.all(promises);
  }
}

export const metricsRecorder = new MetricsRecorder(metricsDb);
