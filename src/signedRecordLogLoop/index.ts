import { appFeatures } from '@/app-features';
import { PersonalRecordsStateEntity } from '@/entities/IPersonalRecordsState';
import {
  SignedRecordLogEntryEntity,
  SignedRecordLogSegmentEntity
} from '@/entities/ISignedRecordLog';
import { createRecordLogSegmenter } from '@/signed-records/record-log/record-log';
import { runPersonalImport } from '@/personal-records/personal-import-task';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('SIGNED_RECORD_LOG_LOOP');

/**
 * The interim record log. SIGNED_RECORD_LOG_TASK=close (every 5 minutes)
 * closes segments, pins them and posts their heads; =archive (hourly)
 * uploads posted segments to Arweave and lists them in an archive drop.
 * Does nothing unless FEATURE_SIGNED_RECORD_LOG is true. Invoked by hand at
 * the personal settings switch with {"task": "personal-freeze"},
 * {"task": "personal-import"} or {"task": "personal-unfreeze"}.
 */
export const handler = sentryContext.wrapLambdaHandler(
  async (event?: { readonly task?: string }) => {
    await doInDbContext(
      async () => {
        if (!appFeatures.isSignedRecordLogEnabled()) {
          logger.info('[SIGNED RECORD LOG OFF]');
          return;
        }
        // Invoked by hand at the personal settings switch.
        if (event?.task === 'personal-freeze') {
          await personalRecordsStateDb.setFrozen(true);
          logger.info('[PERSONAL SETTINGS FROZEN]');
          return;
        }
        if (event?.task === 'personal-unfreeze') {
          await personalRecordsStateDb.setFrozen(false);
          logger.info('[PERSONAL SETTINGS UNFROZEN]');
          return;
        }
        if (event?.task === 'personal-import') {
          await runPersonalImport();
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
        entities: [
          SignedRecordLogEntryEntity,
          SignedRecordLogSegmentEntity,
          PersonalRecordsStateEntity
        ]
      }
    );
  }
);
