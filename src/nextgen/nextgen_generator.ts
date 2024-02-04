import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GENERATOR_BASE_PATH, NEXTGEN_BUCKET } from './nextgen_constants';
import { Logger } from '../logging';
import axios from 'axios';

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
  const returnError = (error: string) => {
    logger.error(`[GENERATOR IMAGE ERROR] : [PATH ${path}] : [ERROR ${error}]`);
    return;
  };

  try {
    const genImageResponse = await axios.get(`${GENERATOR_BASE_PATH}/${path}`, {
      responseType: 'arraybuffer',
      timeout: 300000 // (5 minutes)
    });
    if (genImageResponse.status !== 200) {
      return returnError(`[STATUS ${genImageResponse.status}]`);
    }
    logger.info(`[IMAGE ${path} DOWNLOADED]`);
    return genImageResponse.data;
  } catch (error: any) {
    return returnError(`[ERROR ${error.message}]`);
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

export function triggerGenerator(uri: string) {
  let metadataPath = uri.startsWith('/') ? uri.slice(1) : uri;
  triggerGeneratorPath(metadataPath);
  const imagePath = metadataPath.replace('/metadata/', '/png/');
  triggerGeneratorPath(imagePath);
}

export function triggerGeneratorPath(path: string) {
  const genPath = `${GENERATOR_BASE_PATH}/${path}`;
  fetch(genPath);
}
