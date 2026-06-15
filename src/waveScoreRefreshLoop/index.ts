import * as sentryContext from '../sentry.context';
import { DropEntity, DropMentionedWaveEntity } from '../entities/IDrop';
import { IdentityEntity } from '../entities/IIdentity';
import { IdentitySubscriptionEntity } from '../entities/IIdentitySubscription';
import { Rating } from '../entities/IRating';
import { WaveEntity } from '../entities/IWave';
import { WaveMetricEntity } from '../entities/IWaveMetric';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { waveScoreService } from '../api-serverless/src/waves/wave-score.service';

const logger = Logger.get('WAVE_SCORE_REFRESH_LOOP');

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  return value;
}

function parseStringEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('WAVE_SCORE_REFRESH_LOOP');
      try {
        const result = await waveScoreService.refreshAllWaveScores(
          {
            batchSize: parsePositiveIntEnv('WAVE_SCORE_REFRESH_BATCH_SIZE'),
            maxBatches: parsePositiveIntEnv('WAVE_SCORE_REFRESH_MAX_BATCHES'),
            startAfterWaveId: parseStringEnv(
              'WAVE_SCORE_REFRESH_START_AFTER_WAVE_ID'
            )
          },
          { timer }
        );
        logger.info(`Refreshed wave scores ${JSON.stringify(result)}`);
      } finally {
        logger.info(`Finished executing ${timer.getReport()}`);
      }
    },
    {
      logger,
      entities: [
        DropEntity,
        DropMentionedWaveEntity,
        IdentityEntity,
        IdentitySubscriptionEntity,
        Rating,
        WaveEntity,
        WaveMetricEntity
      ]
    }
  );
});
