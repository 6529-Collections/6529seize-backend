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
import { sqs } from '../sqs';
import { env } from '../env';

export class RecalculateXTdhUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly xtdhRepository: XTdhRepository,
    private readonly reReviewRatesInXTdhGrants: ReReviewRatesInXTdhGrantsUseCase,
    private readonly recalculateXTdhStats: RecalculateXTdhStatsUseCase
  ) {}

  public async handle(ctx: RequestContext) {
    if (ctx.connection) {
      await this.recalculateXTdh(ctx);
    } else {
      await this.xtdhRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.recalculateXTdh({ ...ctx, connection });
        }
      );
      await this.recalculateXTdhStats.handle(ctx);
    }
  }

  private async recalculateXTdh(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->recalculateXTdh`);
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
      this.logger.info(`xTDH universe has been recalculated`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->recalculateXTdh`);
    }
  }

  public async activateLoop(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->activateLoop`);
      const xtdhLoopQueueUrl = env.getStringOrNull('XTDH_LOOP_QUEUE_URL');
      if (!xtdhLoopQueueUrl) {
        this.logger.warn(
          `XTDH_LOOP_QUEUE_URL not configured. Skipping loop call.`
        );
      } else {
        await sqs.send({
          message: {},
          queue: xtdhLoopQueueUrl
        });
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->activateLoop`);
    }
  }
}

export const recalculateXTdhUseCase = new RecalculateXTdhUseCase(
  xTdhRepository,
  reReviewRatesInXTdhGrantsUseCase,
  recalculateXTdhStatsUseCase
);
