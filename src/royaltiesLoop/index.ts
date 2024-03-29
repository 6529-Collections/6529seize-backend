import { RoyaltiesUpload } from '../entities/IRoyalties';
import { findRoyalties } from '../royalties';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const Arweave = require('arweave');
const csvParser = require('csv-parser');

const logger = Logger.get('ROYALTIES_LOOP');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    logger.info('[RUNNING]');
    await loadEnv([RoyaltiesUpload]);
    await findRoyalties();
    logger.info('[COMPLETE]');
  }
);
