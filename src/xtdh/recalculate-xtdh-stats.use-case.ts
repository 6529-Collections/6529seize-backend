import { RequestContext } from '../request.context';
import { xTdhRepository, XTdhRepository } from './xtdh.repository';
import { Logger } from '../logging';
import { metricsRecorder } from '../metrics/MetricsRecorder';

export class RecalculateXTdhStatsUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly xtdhRepository: XTdhRepository) {}

  public async handle(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->handle`);
      this.logger.info(`Determining currently active meta`);
      const meta = await this.xtdhRepository.getStatsMetaOrNull(ctx);
      const slot = meta?.active_slot === 'a' ? 'b' : 'a';
      this.logger.info(`Indexing XTDH stats to slot ${slot}`);
      this.logger.info(`Indexing grant stats`);
      await this.xtdhRepository.refillXTdhGrantStats(
        {
          slot
        },
        ctx
      );
      this.logger.info(`Grant stats indexed`);
      this.logger.info(`Indexing token stats`);
      await this.xtdhRepository.refillXTdhTokenStats(
        {
          slot
        },
        ctx
      );
      const xtdhGranted = await this.xtdhRepository.getTotalGrantedXTdh(
        { slot },
        ctx
      );
      await metricsRecorder.recordXtdhGranted({ xtdhGranted }, ctx);
      this.logger.info(`Token stats indexed`);
      this.logger.info(`Activating slot ${slot}`);
      await this.xtdhRepository.markStatsJustReindexed(
        {
          slot
        },
        ctx
      );
      this.logger.info(`Slot ${slot} activated`);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }
}

export const recalculateXTdhStatsUseCase = new RecalculateXTdhStatsUseCase(
  xTdhRepository
);
