import { RequestContext } from '../request.context';
import { xTdhRepository, XTdhRepository } from './xtdh.repository';
import { Logger } from '../logging';
import { identitiesService } from '../api-serverless/src/identities/identities.service';

export class RecalculateXTdhUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly xtdhRepository: XTdhRepository) {}

  public async handle(ctx: RequestContext) {
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
    this.logger.info(`Recalculating the xTDH universe`);
    try {
      ctx.timer?.start(`${this.constructor.name}->recalculateXTdh`);
      if (!ctx.connection) {
        throw new Error(
          `Can not recalculateXTdh outside of active transaction`
        );
      }
      this.logger.info(`Updating baseTdh rate`);
      await this.xtdhRepository.updateBoostedTdhRate(ctx);
      this.logger.info(`Updated baseTdh rate`);
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

      this.logger.info(`Creating missing tdh_consolidations`);
      await this.xtdhRepository.createMissingTdhConsolidations(ctx);
      this.logger.info(`Created missing tdh_consolidations`);

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
      this.logger.info(`Updating total TDHs`);
      await this.xtdhRepository.updateTotalTdhs(ctx);
      this.logger.info(`Total TDHs updated`);
      this.logger.info(`xTDH universe has been recalculated`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->recalculateXTdh`);
    }
  }
}

export const recalculateXTdhUseCase = new RecalculateXTdhUseCase(
  xTdhRepository
);
