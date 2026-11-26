import { appFeatures } from '@/app-features';
import {
  SignedRecordLogEntryEntity,
  SignedRecordLogSegmentEntity
} from '@/entities/ISignedRecordLog';
import { createRecordLogSegmenter } from '@/signed-records/record-log/record-log';
import { readRecordsWaveSetting } from '@/waves-scope/waves-scope';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('SIGNED_RECORD_LOG_LOOP');

let reportedNoRecordsWave = false;

/**
 * The interim record log. SIGNED_RECORD_LOG_TASK=close (every 5 minutes)
 * closes segments, pins them and posts their heads; =archive (hourly)
 * uploads posted segments to Arweave and lists them in an archive drop.
 * Does nothing unless FEATURE_SIGNED_RECORD_LOG is true. With
 * SIGNED_RECORDS_WAVE_ID=none (6529.io has no records wave) it posts
 * nothing and closes nothing: the entries wait in their table, and that is
 * logged once per cold start. Unset is a mistake: the run fails, as before.
 */
export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      if (!appFeatures.isSignedRecordLogEnabled()) {
        logger.info('[SIGNED RECORD LOG OFF]');
        return;
      }
      if (readRecordsWaveSetting(process.env).kind === 'none') {
        if (!reportedNoRecordsWave) {
          reportedNoRecordsWave = true;
          logger.info(
            '[RECORDS WAVE: none] [NOTHING IS POSTED] [ENTRIES WAIT IN THEIR TABLE]'
          );
        }
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
