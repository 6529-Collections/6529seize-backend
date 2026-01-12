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

  async recordVote(
    {
      wave_id,
      vote_change,
      voter_id
    }: { wave_id: string; vote_change: number; voter_id: string },
    ctx: RequestContext
  ) {
    const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
    if (!mainStageWaveId || wave_id !== mainStageWaveId) {
      return;
    }
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.MAIN_STAGE_VOTE,
        scope: voter_id,
        event_count: 1,
        value_sum: vote_change
      },
      ctx
    );
  }

  async recordNetworkTdh({ tdh }: { tdh: number }, ctx: RequestContext) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.NETWORK_TDH,
        event_count: 1,
        value_sum: tdh,
        overwrite: true
      },
      ctx
    );
  }

  async recordTdhOnMainStageSubmissions(
    { tdhOnMainStageSubmissions }: { tdhOnMainStageSubmissions: number },
    ctx: RequestContext
  ) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS,
        event_count: 1,
        value_sum: tdhOnMainStageSubmissions,
        overwrite: true
      },
      ctx
    );
  }
}

export const metricsRecorder = new MetricsRecorder(metricsDb);
