import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';
import { Logger } from './logging';

let cloudfront: CloudFrontClient;

const logger = Logger.get('CLOUDFRONT');

const getCloudfront = () => {
  cloudfront ??= new CloudFrontClient({ region: 'us-east-1' });
  return cloudfront;
};

export const invalidateCloudFront = async (
  distribution: string,
  paths: string[]
) => {
  const cloudfront = getCloudfront();
  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: distribution,
        InvalidationBatch: {
          CallerReference: Date.now().toString(),
          Paths: {
            Quantity: paths.length,
            Items: paths
          }
        }
      })
    );
    logger.info(`[INVALIDATED PATHS (${paths.length}): ${paths}]`);
  } catch (e) {
    logger.info(`[INVALIDATE ERROR: ${e}]`);
  }
};
