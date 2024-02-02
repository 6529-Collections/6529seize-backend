import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GENERATOR_BASE_PATH, NEXTGEN_BUCKET } from './nextgen_constants';
import { Logger } from '../logging';

const logger = Logger.get('NEXTGEN_GENERATOR');

export interface Details {
  network: string;
  tokenId?: number;
  collection?: number;
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
  const genImageResponse = await fetch(`${GENERATOR_BASE_PATH}/${path}`);
  if (genImageResponse.status !== 200) {
    logger.info(
      `[GENERATOR IMAGE ERROR RESPONSE] : [STATUS ${genImageResponse.status}] : [PATH ${path}]`
    );
    return;
  }
  const imageBlob = await genImageResponse.arrayBuffer();
  logger.info(`[IMAGE ${path} DOWNLOADED]`);
  return imageBlob;
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
      Body: Buffer.from(imageBlob),
      ContentType: `image/png`
    })
  );
}
