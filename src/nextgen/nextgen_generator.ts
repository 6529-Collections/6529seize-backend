import {
  S3Client,
  PutObjectCommand,
  ListObjectsCommand
} from '@aws-sdk/client-s3';
import {
  CLOUDFRONT_DISTRIBUTION,
  GENERATOR_BASE_PATH,
  NEXTGEN_BUCKET
} from './nextgen_constants';
import { Logger } from '../logging';
import axios from 'axios';
import {
  CloudFrontClient,
  CreateInvalidationCommand
} from '@aws-sdk/client-cloudfront';

const logger = Logger.get('NEXTGEN_GENERATOR');

export interface Details {
  network: string;
  tokenId?: number;
  collection?: number;
}

export async function listS3Objects(
  s3: S3Client,
  path: string
): Promise<number[]> {
  const command = new ListObjectsCommand({
    Bucket: NEXTGEN_BUCKET,
    Prefix: path
  });
  const contents: number[] = [];
  const response = await s3.send(command);
  response.Contents?.forEach((object) => {
    if (object.Key) {
      contents.push(parseInt(object.Key?.replace(path, '')));
    }
  });
  return contents;
}

export async function getNextBatch(
  allExisting: number[],
  startIndex: number,
  endIndex: number,
  batchSize: number
): Promise<number[]> {
  const nextBatch = [];
  for (let i = startIndex; i <= endIndex; i++) {
    if (!allExisting.includes(i)) {
      nextBatch.push(i);
    }
    if (nextBatch.length >= batchSize) {
      break;
    }
  }
  return nextBatch;
}

export function getGenDetailsFromUri(uri: string): Details {
  if (uri.startsWith('/')) {
    uri = uri.slice(1);
  }
  const uriSegments = uri.split('/');
  const network = uriSegments[0];
  const tokenIdStr = uriSegments.pop();

  const tokenId = Number(tokenIdStr);
  if (!isNaN(tokenId)) {
    const collection = Math.round(tokenId / 10000000000);
    return {
      network: network,
      tokenId: tokenId,
      collection: collection
    };
  }
  return {
    network: network
  };
}

export async function getImageBlobFromGenerator(path: string) {
  const returnError = (error: string) => {
    logger.error(`[GENERATOR IMAGE ERROR] : [PATH ${path}] : [${error}]`);
  };

  try {
    const genImageResponse = await axios.get(`${GENERATOR_BASE_PATH}/${path}`, {
      responseType: 'arraybuffer',
      timeout: 720000 // (12 minutes)
    });
    if (genImageResponse.status !== 200) {
      return returnError(`STATUS ${genImageResponse.status}`);
    }
    logger.info(`[IMAGE ${path} DOWNLOADED]`);
    return genImageResponse.data;
  } catch (error: any) {
    return returnError(`ERROR ${error.message}`);
  }
}

export async function s3UploadNextgenImage(
  s3: S3Client,
  imageBlob: any,
  path: string
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: NEXTGEN_BUCKET,
      Key: path,
      Body: imageBlob,
      ContentType: `image/png`
    })
  );
}

export async function invalidatePath(
  cloudfront: CloudFrontClient,
  path: string
) {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/', 3);
  const invalidationPath = `/${pathParts[1]}/*`;
  logger.info(`[INVALIDATING PATH] : [PATH ${invalidationPath}]`);
  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: CLOUDFRONT_DISTRIBUTION,
        InvalidationBatch: {
          CallerReference: Date.now().toString(),
          Paths: {
            Quantity: 1,
            Items: [invalidationPath]
          }
        }
      })
    );
  } catch (e) {
    logger.info(
      `[INVALIDATE ERROR] : [PATH ${invalidationPath}] : [ERROR ${e}]`
    );
  }
}
