/**
 * Operator steps for the notification view's switch to `on`. See
 * docs/notification-view.md ("The switch"). Each step is resumable and safe
 * to run again; nothing here runs on a schedule. It runs with the same
 * configuration as the API (database, NOTIFY_VIEW_MODE and
 * NOTIFY_DERIVED_CAUSES), loaded the way the loops load it.
 *
 *   status        counts of the view's rows by origin, and the cursors
 *   copy-old-rows prune the rows the deriver does not own, then copy every
 *                 identity_notifications row the view lacks (run before
 *                 and again after setting NOTIFY_VIEW_MODE=on); each run
 *                 starts a little below where the last one ended
 *   copy-old-rows --full
 *                 the same, reading every row from the first (the last
 *                 run, once no service writes in `shadow`)
 *   seal          write the CARRIED rows not yet archived to the record log
 *   record-cuts   write each derived cause's windows to the record log
 *                 (run after every change to NOTIFY_DERIVED_CAUSES)
 */
import 'reflect-metadata';
import { doInDbContext } from '../../../src/secrets';
import { Logger } from '../../../src/logging';
import { sqlExecutor } from '../../../src/sql-executor';
import {
  NOTIFICATION_VIEW_CURSORS_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '../../../src/constants';
import { notificationViewSwitch } from '../../../src/notifications/view/notification-view-switch';
import { notificationArchive } from '../../../src/notifications/view/notification-archive';

const logger = Logger.get('NOTIFICATION_VIEW_CLI');
const MODES = ['status', 'copy-old-rows', 'seal', 'record-cuts'] as const;
type Mode = (typeof MODES)[number];

async function status() {
  const rows = await sqlExecutor.execute(
    `select origin, sealed, count(*) as n from ${NOTIFICATION_VIEW_TABLE}
     group by origin, sealed order by origin, sealed`
  );
  const cursors = await sqlExecutor.execute(
    `select source, cursor_value, updated_at from ${NOTIFICATION_VIEW_CURSORS_TABLE} order by source`
  );
  logger.info(`[VIEW ROWS] ${JSON.stringify(rows)}`);
  logger.info(`[CURSORS] ${JSON.stringify(cursors)}`);
}

async function untilDone(
  step: () => Promise<{ rows: number; done: boolean }>,
  label: string
) {
  let total = 0;
  for (;;) {
    const { rows, done } = await step();
    total += rows;
    if (done) break;
  }
  logger.info(`[${label}] ${total} rows`);
}

async function main(mode: Mode) {
  await doInDbContext(
    async () => {
      switch (mode) {
        case 'status':
          return status();
        case 'copy-old-rows': {
          // The prune keeps the derived rows inside these windows.
          logger.info(
            `[MODE ${process.env.NOTIFY_VIEW_MODE ?? ''}] [NOTIFY_DERIVED_CAUSES ${process.env.NOTIFY_DERIVED_CAUSES ?? ''}]`
          );
          const { pruned, copied } =
            await notificationViewSwitch.copyOldRowsRun({ full });
          logger.info(`[PRUNED] ${pruned} rows`);
          logger.info(
            `[COPIED OLD ROWS] ${copied} rows${full ? ' (full)' : ''}`
          );
          return;
        }
        case 'seal':
          return untilDone(() => notificationArchive.sealCarried(), 'SEALED');
        case 'record-cuts':
          return notificationArchive.recordCuts({});
      }
    },
    { logger, skipRedis: true }
  );
}

const mode = process.argv[2] as Mode;
const options = process.argv.slice(3);
const full = options.includes('--full');
if (
  !MODES.includes(mode) ||
  options.some((option) => option !== '--full') ||
  (full && mode !== 'copy-old-rows')
) {
  logger.error(`Usage: cli.ts ${MODES.join(' | ')} (copy-old-rows [--full])`);
  process.exit(2);
}
main(mode).catch((error) => {
  logger.error(`[FAILED] ${error}`);
  process.exit(1);
});
