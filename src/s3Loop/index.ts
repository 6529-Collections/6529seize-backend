import { fetchAllMemeLabNFTs, fetchAllNFTs } from '../db';
import { persistS3 } from '../s3';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('S3_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await s3Loop();
    },
    { logger }
  );
});

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
