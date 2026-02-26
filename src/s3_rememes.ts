import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { RequestInfo, RequestInit } from 'node-fetch';
import { Rememe } from './entities/IRememe';
import { CLOUDFRONT_LINK } from '@/constants';
import { resizeImageBufferToHeight } from '@/media/image-resize';
import { persistRememes } from './db';
import { Logger } from './logging';
import { ipfs } from './ipfs';
import { mediaChecker } from './media-checker';

const logger = Logger.get('S3_REMEMES');

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;

let s3: S3Client;
let myBucket: string;

export const persistRememesS3 = async (rememes: Rememe[]) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  logger.info(`[PROCESSING ASSETS FOR ${rememes.length} REMEMES]`);

  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  await Promise.all(rememes.map((r) => processRememeS3(r)));
};

async function processRememeS3(r: Rememe) {
  const image = resolveRememeImageUrl(r);
  if (!image) {
    return;
  }

  const format = await mediaChecker.getContentType(image);
  if (!format) {
    logger.error(`[ERROR ${r.contract} #${r.id}] [INVALID FORMAT ${image}]`);
    return;
  }

  const keys = getRememeImageKeys(r, format);
  const originalExists = await objectExists(myBucket, keys.originalKey);

  if (originalExists) {
    logger.info(`[EXISTS ${r.contract} #${r.id}] [SKIPPING UPLOAD]`);
  } else {
    await uploadMissingRememeAssets(r, image, format, keys);
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

function resolveRememeImageUrl(r: Rememe): string {
  return r.media && r.media.gateway
    ? r.media.gateway
    : ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(r.image);
}

function getRememeImageKeys(r: Rememe, format: string) {
  return {
    originalKey: `rememes/images/original/${r.contract}-${r.id}.${format}`,
    scaledKey: `rememes/images/scaled/${r.contract}-${r.id}.${format}`,
    thumbnailKey: `rememes/images/thumbnail/${r.contract}-${r.id}.${format}`,
    iconKey: `rememes/images/icon/${r.contract}-${r.id}.${format}`
  };
}

async function uploadMissingRememeAssets(
  r: Rememe,
  imageUrl: string,
  format: string,
  keys: {
    originalKey: string;
    scaledKey: string;
    thumbnailKey: string;
    iconKey: string;
  }
) {
  logger.info(`[MISSING IMAGE] [CONTRACT ${r.contract}] [ID ${r.id}]`);

  const res = await fetch(
    ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(imageUrl)
  );
  const blob = await res.arrayBuffer();
  const blobBuffer = Buffer.from(blob);

  await handleImageUpload(keys.originalKey, format, blob);

  const scaledToWebp = format.toLowerCase() !== 'gif';
  const scaledBuffer = await resizeImage(r, scaledToWebp, blobBuffer, SCALED_HEIGHT);
  if (scaledBuffer) {
    await handleImageUpload(keys.scaledKey, format, scaledBuffer);
  }

  const thumbnailBuffer = await resizeImage(
    r,
    scaledToWebp,
    blobBuffer,
    THUMBNAIL_HEIGHT
  );
  if (thumbnailBuffer) {
    await handleImageUpload(keys.thumbnailKey, format, thumbnailBuffer);
  }

  const iconBuffer = await resizeImage(r, scaledToWebp, blobBuffer, ICON_HEIGHT);
  if (iconBuffer) {
    await handleImageUpload(keys.iconKey, format, iconBuffer);
  }
}

async function getRememeAssetPresence(keys: {
  originalKey: string;
  scaledKey: string;
  thumbnailKey: string;
  iconKey: string;
}) {
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

async function persistRememeS3Links(
  r: Rememe,
  keys: {
    originalKey: string;
    scaledKey: string;
    thumbnailKey: string;
    iconKey: string;
  }
) {
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
    if (toWEBP) {
      return await resizeImageBufferToHeight({
        buffer,
        height,
        toWebp: true
      });
    } else {
      return await resizeImageBufferToHeight({
        buffer,
        height,
        toWebp: false
      });
    }
  } catch (err: any) {
    logger.error(
      `[RESIZING FOR ${rememe.contract} #${rememe.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}
