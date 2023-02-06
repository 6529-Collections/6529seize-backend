import { persistS3 } from '../s3';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING S3 LOOP]');
  await loadEnv();
  await s3Loop();
  console.log(new Date(), '[S3 LOOP COMPLETE]');
};

export async function s3Loop() {
  if (process.env.NODE_ENV == 'production') {
    await persistS3();
  } else {
    console.log(
      new Date(),
      '[S3]',
      '[SKIPPING]',
      `[CONFIG ${process.env.NODE_ENV}]`
    );
  }
}
