import { RoyaltiesUpload } from '../entities/IRoyalties';
import { findRoyalties } from '../royalties';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('ROYALTIES_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await findRoyalties();
    },
    { logger, entities: [RoyaltiesUpload] }
  );
});
