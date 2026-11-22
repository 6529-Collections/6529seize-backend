import { appFeatures } from '@/app-features';
import {
  SignedRecordLogEntryEntity,
  SignedRecordLogSegmentEntity
} from '@/entities/ISignedRecordLog';
import { createRecordLogSegmenter } from '@/signed-records/record-log/record-log';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('SIGNED_RECORD_LOG_LOOP');

/**
 * The interim record log. SIGNED_RECORD_LOG_TASK=close (every 5 minutes)
 * closes segments, pins them and posts their heads; =archive (hourly)
 * uploads posted segments to Arweave and lists them in an archive drop.
 * Does nothing unless FEATURE_SIGNED_RECORD_LOG is true.
 */
export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      if (!appFeatures.isSignedRecordLogEnabled()) {
        logger.info('[SIGNED RECORD LOG OFF]');
        return;
      }
      const segmenter = createRecordLogSegmenter();
      if (process.env.SIGNED_RECORD_LOG_TASK === 'archive') {
        const archived = await segmenter.archive({});
        logger.info(`[ARCHIVED ${archived} SEGMENTS]`);
        return;
      }
      const heads = await segmenter.closeSegments({});
      logger.info(`[CLOSED ${heads.length} SEGMENTS]`);
    },
    {
      logger,
      entities: [SignedRecordLogEntryEntity, SignedRecordLogSegmentEntity]
    }
  );
});
