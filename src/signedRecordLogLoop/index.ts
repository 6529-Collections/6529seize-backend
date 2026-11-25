import { appFeatures } from '@/app-features';
import { PersonalRecordsStateEntity } from '@/entities/IPersonalRecordsState';
import {
  SignedRecordLogEntryEntity,
  SignedRecordLogSegmentEntity
} from '@/entities/ISignedRecordLog';
import { createRecordLogSegmenter } from '@/signed-records/record-log/record-log';
import { readRecordsWaveSetting } from '@/waves-scope/waves-scope';
import { runPersonalImport } from '@/personal-records/personal-import-task';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('SIGNED_RECORD_LOG_LOOP');

let reportedNoRecordsWave = false;

// The hand-run tasks. The schedules send no task: their job comes from
// SIGNED_RECORD_LOG_TASK.
const HAND_TASKS: readonly unknown[] = [
  'personal-freeze',
  'personal-import',
  'personal-unfreeze'
];

/**
 * The interim record log. SIGNED_RECORD_LOG_TASK=close (every 5 minutes)
 * closes segments, pins them and posts their heads; =archive (hourly)
 * uploads posted segments to Arweave and lists them in an archive drop.
 * Does nothing unless FEATURE_SIGNED_RECORD_LOG is true. With
 * SIGNED_RECORDS_WAVE_ID=none (6529.io has no records wave) it posts
 * nothing and closes nothing: the entries wait in their table, and that is
 * logged once per cold start. Unset is a mistake: the run fails, as before.
 *
 * Invoked by hand at the personal settings switch with
 * {"task": "personal-freeze"}, {"task": "personal-import"} or
 * {"task": "personal-unfreeze"}; none of them posts anything. Freezing and
 * the import refuse while the flag is off or no records wave is set, so an
 * operator never takes a task that did nothing for one that ran; so does
 * any other task name. Unfreezing, the way back, runs whatever the flag and
 * the records wave say.
 */
export const handler = sentryContext.wrapLambdaHandler(
  async (event?: { readonly task?: string }) => {
    await doInDbContext(
      async () => {
        if (event?.task !== undefined && !HAND_TASKS.includes(event.task)) {
          throw new Error(`unknown task ${String(event.task)}`);
        }
        // Invoked by hand at the personal settings switch. Unfreezing is the
        // way back, so it runs even with the record log off; it writes only
        // the switch state.
        if (event?.task === 'personal-unfreeze') {
          await personalRecordsStateDb.setFrozen(false);
          logger.info('[PERSONAL SETTINGS UNFROZEN]');
          return;
        }
        const switchTask =
          event?.task === 'personal-freeze' ||
          event?.task === 'personal-import';
        if (!appFeatures.isSignedRecordLogEnabled()) {
          if (switchTask) throw new Error('signed record log off');
          logger.info('[SIGNED RECORD LOG OFF]');
          return;
        }
        // Freezing and the import wait for a records wave.
        if (switchTask && readRecordsWaveSetting(process.env).kind !== 'id') {
          throw new Error('no records wave set');
        }
        if (event?.task === 'personal-freeze') {
          await personalRecordsStateDb.setFrozen(true);
          logger.info('[PERSONAL SETTINGS FROZEN]');
          return;
        }
        if (event?.task === 'personal-import') {
          await runPersonalImport();
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
        entities: [
          SignedRecordLogEntryEntity,
          SignedRecordLogSegmentEntity,
          PersonalRecordsStateEntity
        ]
      }
    );
  }
);
