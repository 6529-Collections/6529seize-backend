import {
  metricsDb,
  MetricsDb,
  MetricRollupHourUpsertParams
} from './MetricsDb';
import { MetricRollupHourMetric } from '../entities/IMetricRollupHour';
import { DropType } from '../entities/IDrop';
import { env } from '../env';
import { Logger } from '../logging';
import { RequestContext } from '../request.context';
import {
  competitionMainStageRepository,
  CompetitionMainStageRepository
} from '@/competitions/competition-main-stage.repository';

const logger = Logger.get('METRICS_RECORDER');

type CreatedDrop = {
  readonly identityId: string;
  readonly waveId: string;
  readonly dropType: DropType;
};

function isDeadlockVictim(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return code === 'ER_LOCK_DEADLOCK' || errno === 1213;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

export class MetricsRecorder {
  constructor(
    private readonly metricsDb: MetricsDb,
    private readonly nativeMainStage: Pick<
      CompetitionMainStageRepository,
      'isDesignated'
    > = competitionMainStageRepository
  ) {}

  async recordNativeCompetitionSubmission(
    { competitionId }: { competitionId: string },
    ctx: RequestContext
  ) {
    if (!(await this.nativeMainStage.isDesignated(competitionId, ctx))) return;
    await this.metricsDb.upsertMetricRollupHour(
      { metric: MetricRollupHourMetric.MAIN_STAGE_SUBMISSION, event_count: 1 },
      ctx
    );
  }

  async recordNativeCompetitionVote(
    {
      competitionId,
      voterId,
      voteChange
    }: { competitionId: string; voterId: string; voteChange: number | string },
    ctx: RequestContext
  ) {
    if (
      voteChange === 0 ||
      voteChange === '0' ||
      !(await this.nativeMainStage.isDesignated(competitionId, ctx))
    )
      return;
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.MAIN_STAGE_VOTE,
        scope: voterId,
        event_count: 1,
        value_sum: voteChange
      },
      ctx
    );
  }

  /** A created drop's rollups, in primary-key order within the hour. */
  private createdDropRollups({
    identityId,
    waveId,
    dropType
  }: CreatedDrop): MetricRollupHourUpsertParams[] {
    const mainStageWaveId = env.getStringOrNull(`MAIN_STAGE_WAVE_ID`);
    return [
      {
        metric: MetricRollupHourMetric.ACTIVE_IDENTITY,
        scope: identityId,
        event_count: 1
      },
      { metric: MetricRollupHourMetric.DROP, event_count: 1 },
      {
        metric: MetricRollupHourMetric.DROPPER_DROP,
        scope: identityId,
        event_count: 1
      },
      ...(mainStageWaveId &&
      waveId === mainStageWaveId &&
      dropType === DropType.PARTICIPATORY
        ? [
            {
              metric: MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
              event_count: 1
            }
          ]
        : [])
    ];
  }

  /**
   * Rollups for a created drop: the author's ACTIVE_IDENTITY, DROP (one
   * global row per hour), DROPPER_DROP and, for Main Stage submissions,
   * MAIN_STAGE_SUBMISSION.
   *
   * Call it after the drop's transaction commits, never inside it. Every
   * post updates the hour's DROP/global row, so inside the transaction each
   * post held that row's lock until it committed: posts queued behind one
   * another, and a post inserting its first ACTIVE_IDENTITY row of the hour
   * next to DROP/global deadlocked with the posts waiting for it. Here each
   * upsert is its own autocommit statement, one at a time in primary-key
   * order, retried once if it is chosen as a deadlock victim. Best effort:
   * a failure is logged and the rest still run; it never throws.
   */
  async recordCreatedDropAfterCommit(
    drop: CreatedDrop,
    { timer }: Pick<RequestContext, 'timer'> = {}
  ): Promise<void> {
    for (const params of this.createdDropRollups(drop)) {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.metricsDb.upsertMetricRollupHour(params, { timer });
          break;
        } catch (error) {
          if (attempt === 1 && isDeadlockVictim(error)) continue;
          logger.warn(
            `Created-drop rollup ${params.metric} not recorded: ${errorCode(error)}`
          );
          break;
        }
      }
    }
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

  async recordConsolidationsFormed(
    { consolidationsFormed }: { consolidationsFormed: number },
    ctx: RequestContext
  ) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.CONSOLIDATIONS_FORMED,
        event_count: 1,
        value_sum: consolidationsFormed,
        overwrite: true
      },
      ctx
    );
  }

  async recordXtdhGranted(
    { xtdhGranted }: { xtdhGranted: number },
    ctx: RequestContext
  ) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.XTDH_GRANTED,
        event_count: 1,
        value_sum: xtdhGranted,
        overwrite: true
      },
      ctx
    );
  }

  async recordActiveIdentity(
    { identityId }: { identityId: string },
    ctx: RequestContext
  ) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.ACTIVE_IDENTITY,
        scope: identityId,
        event_count: 1
      },
      ctx
    );
  }

  async recordProfileCount(
    { profileCount }: { profileCount: number },
    ctx: RequestContext
  ) {
    await this.metricsDb.upsertMetricRollupHour(
      {
        metric: MetricRollupHourMetric.PROFILE_COUNT,
        event_count: 1,
        value_sum: profileCount,
        overwrite: true
      },
      ctx
    );
  }
}

export const metricsRecorder = new MetricsRecorder(metricsDb);
