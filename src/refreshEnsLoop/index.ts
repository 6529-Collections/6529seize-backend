import { refreshEns } from '../ens';
import { ENS } from '../entities/IENS';
import type { Context } from 'aws-lambda';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('REFRESH_ENS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (_event: unknown, context: Context) => {
    await doInDbContext(
      async () => {
        await refreshEns(() => context.getRemainingTimeInMillis());
      },
      {
        logger,
        entities: [ENS]
      }
    );
  }
);
