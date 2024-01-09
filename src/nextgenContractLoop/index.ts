import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import { Logger } from '../logging';
import { Time } from '../time';
import { findCoreTransactions } from '../nextgen';

const logger = Logger.get('NEXTGEN');

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await findCoreTransactions();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
