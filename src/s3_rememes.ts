import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { RequestInfo, RequestInit } from 'node-fetch';
import { Rememe } from './entities/IRememe';
import { CLOUDFRONT_LINK } from '@/constants';
import { resizeImageBufferToHeight } from '@/media/image-resize';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { persistRememes } from './db';
import { Logger } from './logging';
import { ipfs } from './ipfs';
import { mediaChecker } from './media-checker';
import pLimit from 'p-limit';

const logger = Logger.get('S3_REMEMES');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;
const REMEME_CONCURRENCY = 5;

let s3: S3Client;
let myBucket: string;

export const persistRememesS3 = async (rememes: Rememe[]) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  logger.info(`[PROCESSING ASSETS FOR ${rememes.length} REMEMES]`);

  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  const limit = pLimit(REMEME_CONCURRENCY);
  const results = await Promise.allSettled(
    rememes.map((r) => limit(() => processRememeS3(r)))
  );

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (!failures.length) {
    return;
  }

  failures.forEach((failure) =>
    logger.error(`[REMEME PROCESSING FAILED]`, failure.reason)
  );
  throw new Error(
    `Failed processing ${failures.length} of ${rememes.length} rememes`
  );
};

async function processRememeS3(r: Rememe) {
  const image = resolveRememeImageUrl(r);
  if (!image?.length) {
    logger.warn(
      `[REMEME IMAGE URL MISSING] [CONTRACT ${r.contract}] [ID ${r.id}]`
    );
    return;
  }

  const format = await mediaChecker.getContentType(image);
  if (!format) {
    logger.error(`[ERROR ${r.contract} #${r.id}] [INVALID FORMAT ${image}]`);
    return;
  }

  const scaledToWebp = format.toLowerCase() !== 'gif';
  const derivativeFormat = scaledToWebp ? 'webp' : format;
  const keys = getRememeImageKeys(r, format, derivativeFormat);
  const initialPresence = await getRememeAssetPresence(keys);

  if (initialPresence.allPresent) {
    logger.info(`[EXISTS ${r.contract} #${r.id}] [SKIPPING UPLOAD]`);
  } else {
    logger.info(
      `[PARTIAL OR MISSING REMEME S3 ASSETS] [CONTRACT ${r.contract}] [ID ${r.id}] [original=${initialPresence.original}] [scaled=${initialPresence.scaled}] [thumbnail=${initialPresence.thumbnail}] [icon=${initialPresence.icon}]`
    );
    await uploadMissingRememeAssets(
      r,
      image,
      format,
      derivativeFormat,
      keys,
      initialPresence
    );
  }

  const assetPresence = await getRememeAssetPresence(keys);
  if (!assetPresence.allPresent) {
    logger.warn(
      `[INCOMPLETE REMEME S3 ASSETS] [CONTRACT ${r.contract}] [ID ${r.id}] [original=${assetPresence.original}] [scaled=${assetPresence.scaled}] [thumbnail=${assetPresence.thumbnail}] [icon=${assetPresence.icon}] [SKIPPING DB URL PERSIST]`
    );
    return;
  }

  await persistRememeS3Links(r, keys);
}

function resolveRememeImageUrl(r: Rememe): string | undefined {
  const resolved = r.media?.gateway
    ? r.media.gateway
    : ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(r.image);
  if (!resolved) {
    return undefined;
  }
  const trimmed = resolved.trim();
  return trimmed.length ? trimmed : undefined;
}

type RememeImageKeys = {
  originalKey: string;
  scaledKey: string;
  thumbnailKey: string;
  iconKey: string;
};

type RememeAssetPresence = {
  original: boolean;
  scaled: boolean;
  thumbnail: boolean;
  icon: boolean;
  allPresent: boolean;
};

function getRememeImageKeys(
  r: Rememe,
  originalFormat: string,
  derivativeFormat: string
): RememeImageKeys {
  return {
    originalKey: `rememes/images/original/${r.contract}-${r.id}.${originalFormat.toLowerCase()}`,
    scaledKey: `rememes/images/scaled/${r.contract}-${r.id}.${derivativeFormat.toLowerCase()}`,
    thumbnailKey: `rememes/images/thumbnail/${r.contract}-${r.id}.${derivativeFormat.toLowerCase()}`,
    iconKey: `rememes/images/icon/${r.contract}-${r.id}.${derivativeFormat.toLowerCase()}`
  };
}

async function uploadMissingRememeAssets(
  r: Rememe,
  imageUrl: string,
  originalFormat: string,
  derivativeFormat: string,
  keys: RememeImageKeys,
  existingPresence: RememeAssetPresence
) {
  logger.info(`[MISSING IMAGE] [CONTRACT ${r.contract}] [ID ${r.id}]`);

  const res = await withArweaveFallback(imageUrl, (u) => fetch(u));
  if (!res.ok) {
    throw new Error(
      `Failed to fetch rememe image ${imageUrl}: ${res.status} ${res.statusText}`
    );
  }
  const blob = await res.arrayBuffer();
  const blobBuffer = Buffer.from(blob);

  if (!existingPresence.original) {
    await handleImageUpload(keys.originalKey, originalFormat, blob);
  }

  if (!existingPresence.scaled) {
    const scaledBuffer = await resizeImage(
      r,
      derivativeFormat.toLowerCase() === 'webp',
      blobBuffer,
      SCALED_HEIGHT
    );
    if (scaledBuffer) {
      await handleImageUpload(keys.scaledKey, derivativeFormat, scaledBuffer);
    }
  }

  if (!existingPresence.thumbnail) {
    const thumbnailBuffer = await resizeImage(
      r,
      derivativeFormat.toLowerCase() === 'webp',
      blobBuffer,
      THUMBNAIL_HEIGHT
    );
    if (thumbnailBuffer) {
      await handleImageUpload(
        keys.thumbnailKey,
        derivativeFormat,
        thumbnailBuffer
      );
    }
  }

  if (!existingPresence.icon) {
    const iconBuffer = await resizeImage(
      r,
      derivativeFormat.toLowerCase() === 'webp',
      blobBuffer,
      ICON_HEIGHT
    );
    if (iconBuffer) {
      await handleImageUpload(keys.iconKey, derivativeFormat, iconBuffer);
    }
  }
}

async function getRememeAssetPresence(
  keys: RememeImageKeys
): Promise<RememeAssetPresence> {
  const [original, scaled, thumbnail, icon] = await Promise.all([
    objectExists(myBucket, keys.originalKey),
    objectExists(myBucket, keys.scaledKey),
    objectExists(myBucket, keys.thumbnailKey),
    objectExists(myBucket, keys.iconKey)
  ]);

  return {
    original,
    scaled,
    thumbnail,
    icon,
    allPresent: original && scaled && thumbnail && icon
  };
}

async function persistRememeS3Links(r: Rememe, keys: RememeImageKeys) {
  r.s3_image_original = `${CLOUDFRONT_LINK}/${keys.originalKey}`;
  r.s3_image_scaled = `${CLOUDFRONT_LINK}/${keys.scaledKey}`;
  r.s3_image_thumbnail = `${CLOUDFRONT_LINK}/${keys.thumbnailKey}`;
  r.s3_image_icon = `${CLOUDFRONT_LINK}/${keys.iconKey}`;
  await persistRememes([r]);
}

async function handleImageUpload(
  key: string,
  format: string,
  blob: ArrayBuffer | Buffer
) {
  const body = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: key,
      Body: body,
      ContentType: `image/${format}`
    })
  );

  logger.info(`[UPLOADED ${key}] [STATUS ${put.$metadata.httpStatusCode}]`);
}

async function objectExists(myBucket: any, key: any): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: myBucket, Key: key }));
    return true;
  } catch (error1: any) {
    try {
      await s3.send(
        new HeadObjectCommand({ Bucket: myBucket, Key: `${key}__temp` })
      );
      return true;
    } catch (error2: any) {
      return false;
    }
  }
}

async function resizeImage(
  rememe: Rememe,
  toWEBP: boolean,
  buffer: Buffer,
  height: number
): Promise<Buffer | undefined> {
  logger.info(
    `[RESIZING FOR ${rememe.contract} #${rememe.id} (WEBP: ${toWEBP})] [TO TARGET HEIGHT ${height}]`
  );

  try {
    return await resizeImageBufferToHeight({
      buffer,
      height,
      toWebp: toWEBP
    });
  } catch (err: any) {
    logger.error(
      `[RESIZING FOR ${rememe.contract} #${rememe.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}
