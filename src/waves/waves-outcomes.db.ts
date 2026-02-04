import {
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE
} from '@/constants';
import {
  WaveOutcomeDistributionItemEntity,
  WaveOutcomeEntity
} from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export class WavesOutcomesDb extends LazyDbAccessCompatibleService {
  async getWavesOutcomes(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveOutcomeEntity[]>> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getWaveOutcomes`);
      if (!waveIds.length) {
        return {};
      }
      const dbResult = await this.db.execute<WaveOutcomeEntity>(
        `select * from ${WAVE_OUTCOMES_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResult.reduce(
        (acc, it) => {
          if (!acc[it.wave_id]) {
            acc[it.wave_id] = [];
          }
          acc[it.wave_id].push(it);
          return acc;
        },
        {} as Record<string, WaveOutcomeEntity[]>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getWaveOutcomes`);
    }
  }

  async getWavesOutcomesDistributionItems(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, WaveOutcomeDistributionItemEntity[]>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getWavesOutcomesDistributionItems`
      );
      if (!waveIds.length) {
        return {};
      }
      const dbResult = await this.db.execute<WaveOutcomeDistributionItemEntity>(
        `select * from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id in (:waveIds)`,
        { waveIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResult.reduce(
        (acc, it) => {
          if (!acc[it.wave_id]) {
            acc[it.wave_id] = [];
          }
          acc[it.wave_id].push(it);
          return acc;
        },
        {} as Record<string, WaveOutcomeDistributionItemEntity[]>
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getWavesOutcomesDistributionItems`
      );
    }
  }
}

export const wavesOutcomesDb = new WavesOutcomesDb(dbSupplier);
