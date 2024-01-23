import { fetchAllMemeLabNFTs, fetchAllNFTs } from '../db';
import { persistS3 } from '../s3';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('S3_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    logger.info('[RUNNING]');
    await loadEnv();
    await s3Loop();
    await unload();
    logger.info('[COMPLETE]');
  }
);

export async function s3Loop() {
  if (process.env.NODE_ENV == 'production') {
    const nfts = await fetchAllNFTs();
    await persistS3(nfts);
    const nftsLab = await fetchAllMemeLabNFTs();
    await persistS3(nftsLab);
  } else {
    logger.info(`[SKIPPING] [CONFIG ${process.env.NODE_ENV}]`);
  }
}
