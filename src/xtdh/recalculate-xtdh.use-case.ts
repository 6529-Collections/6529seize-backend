import { RequestContext } from '../request.context';
import { xTdhRepository, XTdhRepository } from './xtdh.repository';
import { Logger } from '../logging';
import { identitiesService } from '../api-serverless/src/identities/identities.service';
import {
  reReviewRatesInXTdhGrantsUseCase,
  ReReviewRatesInXTdhGrantsUseCase
} from './re-review-rates-in-xtdh-grants.use-case';
import {
  recalculateXTdhStatsUseCase,
  RecalculateXTdhStatsUseCase
} from './recalculate-xtdh-stats.use-case';
import { DEFAULT_MESSAGE_GROUP_ID, sqs } from '../sqs';
import { env } from '../env';
import { appFeatures } from '../app-features';
import { identityConsolidationEffects } from '../identity';
import {
  XTDH_LOOP_PHASE,
  XTdhLoopMessage,
  XTdhLoopPhase
} from './xtdh-loop-phase';

const MIN_STATS_ENQUEUE_REMAINING_MS = 15_000;

interface HandleUniversePhaseOptions {
  readonly messageGroupId?: string;
  readonly getRemainingTimeInMillis?: () => number;
}

interface ActivateLoopOptions {
  readonly messageGroupId?: string;
}

export class RecalculateXTdhUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly xtdhRepository: XTdhRepository,
    private readonly reReviewRatesInXTdhGrants: ReReviewRatesInXTdhGrantsUseCase,
    private readonly recalculateXTdhStats: RecalculateXTdhStatsUseCase
  ) {}

  public async handleUniversePhase(
    ctx: RequestContext,
    options: HandleUniversePhaseOptions = {}
  ) {
    if (ctx.connection) {
      throw new Error(
        `handleUniversePhase must own the transaction before enqueueing xTDH stats phase`
      );
    }
    this.getRequiredXTdhLoopQueueUrl();
    await this.recalculateXTdhUniverse(ctx);
    this.assertEnoughTimeToEnqueueStats(options.getRemainingTimeInMillis);
    await this.activateLoop(ctx, XTDH_LOOP_PHASE.STATS, options);
  }

  public async handleStatsPhase(ctx: RequestContext) {
    await this.recalculateXTdhStats.handle(ctx);
  }

  private async recalculateXTdhUniverse(ctx: RequestContext) {
    if (ctx.connection) {
      await this.recalculateXTdh(ctx);
    } else {
      await this.xtdhRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.recalculateXTdh({ ...ctx, connection });
        }
      );
    }
  }

  private async recalculateXTdh(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->recalculateXTdh`);
      if (!appFeatures.isXTdhEnabled()) {
        this.logger.warn(`XTDH is disabled`);
        return;
      }
      this.logger.info(`Recalculating the xTDH universe`);
      await this.reReviewRatesInXTdhGrants.handle(ctx);
      if (!ctx.connection) {
        throw new Error(
          `Can not recalculateXTdh outside of active transaction`
        );
      }
      this.logger.info(`Getting wallets without identities`);
      const walletsWithoutIdentities =
        await this.xtdhRepository.getWalletsWithoutIdentities(ctx);
      this.logger.info(
        `Got ${walletsWithoutIdentities.length} wallets without identities`
      );
      if (walletsWithoutIdentities.length) {
        this.logger.info(`Creating the missing identities`);
        await identitiesService.bulkCreateIdentities(
          walletsWithoutIdentities,
          ctx
        );
        this.logger.info(`Missing identities created`);
      }

      this.logger.info(`Updating all produced xTDHs`);
      await this.xtdhRepository.updateProducedXTDH(ctx);
      this.logger.info(`Updated all produced xTDHs`);
      this.logger.info(`Updating all granted xTDH tallies`);
      await this.xtdhRepository.updateAllGrantedXTdhs(ctx);
      this.logger.info(`Updated all granted xTDH tallies`);
      this.logger.info(`Deleting old xTDH state`);
      await this.xtdhRepository.deleteXTdhState(ctx);
      this.logger.info(`Old xTDH state deleted`);

      this.logger.info(`Inserting xTDH states from grants`);
      await this.xtdhRepository.updateAllXTdhsWithGrantedPart(ctx);
      this.logger.info(`xTDH states from grants inserted`);

      this.logger.info(`Upserting rest of xTDH to core card owners`);
      await this.xtdhRepository.giveOutUngrantedXTdh(ctx);
      this.logger.info(`Rest of xTDH upserted to core card owners`);
      this.logger.info(`Updating xTDH rates`);
      await this.xtdhRepository.updateXtdhRate(ctx);
      this.logger.info(`Updated xTDH rates`);
      this.logger.info(`Updating identity levels`);
      await identityConsolidationEffects.updateAllIdentitiesLevels(
        ctx.connection
      );
      this.logger.info(`Updated identity levels`);
      this.logger.info(`xTDH universe has been recalculated`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->recalculateXTdh`);
    }
  }

  public async activateLoop(
    ctx: RequestContext,
    phase: XTdhLoopPhase = XTDH_LOOP_PHASE.UNIVERSE,
    options: ActivateLoopOptions = {}
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->activateLoop`);
      const xtdhLoopQueueUrl =
        phase === XTDH_LOOP_PHASE.STATS
          ? this.getRequiredXTdhLoopQueueUrl()
          : env.getStringOrNull('XTDH_LOOP_QUEUE_URL');
      if (!xtdhLoopQueueUrl) {
        this.logger.warn(
          `XTDH_LOOP_QUEUE_URL not configured. Skipping loop call.`
        );
      } else {
        const messageGroupId =
          options.messageGroupId ??
          (phase === XTDH_LOOP_PHASE.STATS ? DEFAULT_MESSAGE_GROUP_ID : null);
        await sqs.send({
          message: this.buildLoopMessage(phase),
          queue: xtdhLoopQueueUrl,
          ...(messageGroupId ? { messageGroupId } : {})
        });
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->activateLoop`);
    }
  }

  private buildLoopMessage(phase: XTdhLoopPhase): XTdhLoopMessage {
    return {
      phase,
      // Keep same-phase FIFO message bodies unique under content-based dedupe.
      queued_at_ms: Date.now()
    };
  }

  private getRequiredXTdhLoopQueueUrl(): string {
    const xtdhLoopQueueUrl = env.getStringOrNull('XTDH_LOOP_QUEUE_URL');
    if (!xtdhLoopQueueUrl) {
      throw new Error(
        `XTDH_LOOP_QUEUE_URL not configured. Can not enqueue xTDH stats phase.`
      );
    }
    return xtdhLoopQueueUrl;
  }

  private assertEnoughTimeToEnqueueStats(
    getRemainingTimeInMillis?: () => number
  ) {
    const remainingMs = getRemainingTimeInMillis?.();
    if (
      typeof remainingMs === 'number' &&
      remainingMs < MIN_STATS_ENQUEUE_REMAINING_MS
    ) {
      throw new Error(
        `Not enough Lambda time remaining to enqueue xTDH stats phase after universe phase.`
      );
    }
  }
}

export const recalculateXTdhUseCase = new RecalculateXTdhUseCase(
  xTdhRepository,
  reReviewRatesInXTdhGrantsUseCase,
  recalculateXTdhStatsUseCase
);
