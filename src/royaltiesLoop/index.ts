import { RoyaltiesUpload } from '../entities/IRoyalties';
import { findRoyalties } from '../royalties';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const Arweave = require('arweave');

const logger = Logger.get('ROYALTIES_LOOP');

Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await findRoyalties();
    },
    { logger, entities: [RoyaltiesUpload] }
  );
});
