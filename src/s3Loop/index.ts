import { fetchAllMemeLabNFTs, fetchAllNFTs } from '../db';
import { persistS3 } from '../s3';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log('[RUNNING S3 LOOP]');
  await loadEnv();
  await s3Loop();
  await unload();
  console.log('[S3 LOOP COMPLETE]');
};

export async function s3Loop() {
  if (process.env.NODE_ENV == 'production') {
    const nfts = await fetchAllNFTs();
    await persistS3(nfts);
    const nftsLab = await fetchAllMemeLabNFTs();
    await persistS3(nftsLab);
  } else {
    console.log('[S3]', '[SKIPPING]', `[CONFIG ${process.env.NODE_ENV}]`);
  }
}
