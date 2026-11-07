import type { Handler } from 'aws-lambda';
import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { sweepDropWriteOutbox } from './sweep';

const logger = Logger.get('DROP_WRITE_OUTBOX_LOOP');

/**
 * Every minute: finish post outbox rows the wave fan-out worker did not
 * (waves plan 1.8). The worker does the work normally within seconds.
 */
const sweep: Handler = async () => {
  await doInDbContext(
    async () => {
      await sweepDropWriteOutbox();
    },
    { logger, skipRedis: true }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sweep);
