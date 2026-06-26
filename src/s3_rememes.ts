import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { RequestInfo, RequestInit, Response } from 'node-fetch';
import {
  REMEME_S3_MAX_PROCESSING_ATTEMPTS,
  Rememe,
  RememeS3ProcessingStatus
} from './entities/IRememe';
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
const FETCH_TIMEOUT_MS = 30_000;
const LIST_OBJECTS_MAX_KEYS = 25;
const MAX_REMEME_MEDIA_BYTES = 100 * 1024 * 1024;
const PROCESSING_ERROR_MAX_LENGTH = 1000;

const RASTER_IMAGE_FORMATS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);
const UPLOADABLE_UNSUPPORTED_FORMATS = new Set(['mov', 'mp4', 'webm']);
const EXTENSION_PRIORITY = [
  'webp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'mp4',
  'webm',
  'mov',
  'svg'
];

let s3: S3Client;
let myBucket: string;

type RememeAssetKeys = {
  original: string | null;
  scaled: string | null;
  thumbnail: string | null;
  icon: string | null;
};

type RememeDesiredKeys = {
  original: string;
  scaled: string;
  thumbnail: string;
  icon: string;
};

export const persistRememesS3 = async (rememes: Rememe[]) => {
  s3 = new S3Client({ region: 'eu-west-1' });
  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  if (!myBucket) {
    throw new Error('AWS_6529_IMAGES_BUCKET_NAME is required');
  }

  logger.info(`[PROCESSING ASSETS FOR ${rememes.length} REMEMES]`);

  const limit = pLimit(REMEME_CONCURRENCY);
  const results = await Promise.allSettled(
    rememes.map((r) => limit(() => processRememeS3(r)))
  );

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  failures.forEach((failure) =>
    logger.error(`[REMEME PROCESSING FAILED]`, failure.reason)
  );
};

async function processRememeS3(r: Rememe) {
  try {
    await processRememeS3Unsafe(r);
  } catch (error) {
    logger.error(
      `[REMEME PROCESSING ERROR] [CONTRACT ${r.contract}] [ID ${r.id}]`,
      error
    );
    await persistRememeS3Result(r, emptyAssetKeysFromRememe(r), {
      status: retryStatusFor(r),
      error
    });
  }
}

async function processRememeS3Unsafe(r: Rememe) {
  const image = resolveRememeImageUrl(r);
  if (!image?.length) {
    logger.warn(
      `[REMEME IMAGE URL MISSING] [CONTRACT ${r.contract}] [ID ${r.id}]`
    );
    await persistRememeS3Result(r, emptyAssetKeysFromRememe(r), {
      status: RememeS3ProcessingStatus.PERMANENT_ERROR,
      error: 'Missing image URL'
    });
    return;
  }

  const existingAssets = await findExistingRememeAssets(r);
  if (hasCompleteRasterAssetSet(existingAssets)) {
    logger.info(`[EXISTS ${r.contract} #${r.id}] [PERSISTING S3 URLS]`);
    await persistRememeS3Result(r, existingAssets, {
      status: RememeS3ProcessingStatus.COMPLETE
    });
    return;
  }

  const originalFormat =
    getFormatFromKey(existingAssets.original) ??
    normalizeFormat(await mediaChecker.getContentType(image));
  if (!originalFormat) {
    logger.error(
      `[ERROR ${r.contract} #${r.id}] [UNRESOLVED MEDIA FORMAT] [URL ${redactUrlForLog(
        image
      )}]`
    );
    await persistRememeS3Result(r, existingAssets, {
      status: retryStatusFor(r),
      error: 'Could not resolve rememe media format'
    });
    return;
  }

  if (!isRasterImageFormat(originalFormat)) {
    await persistUnsupportedOriginal(r, image, originalFormat, existingAssets);
    return;
  }

  await persistRasterRememe(r, image, originalFormat, existingAssets);
}

function resolveRememeImageUrl(r: Rememe): string | undefined {
  const metadataImage = ipfs.ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(
    r.image
  );
  const resolved = metadataImage.trim().length
    ? metadataImage
    : r.media?.gateway;
  if (!resolved) {
    return undefined;
  }
  const trimmed = resolved.trim();
  return trimmed.length ? trimmed : undefined;
}

async function persistUnsupportedOriginal(
  r: Rememe,
  imageUrl: string,
  originalFormat: string,
  existingAssets: RememeAssetKeys
) {
  logger.warn(
    `[UNSUPPORTED REMEME MEDIA FORMAT] [CONTRACT ${r.contract}] [ID ${r.id}] [FORMAT ${originalFormat}]`
  );

  const assets = { ...existingAssets };
  if (!assets.original) {
    if (!UPLOADABLE_UNSUPPORTED_FORMATS.has(originalFormat)) {
      await persistRememeS3Result(r, assets, {
        status: RememeS3ProcessingStatus.UNSUPPORTED,
        error: `Unsupported rememe media format: ${originalFormat}`
      });
      return;
    }

    const desiredOriginalKey = getOriginalKey(r, originalFormat);
    const media = await fetchRememeMedia(imageUrl, originalFormat);
    await handleObjectUpload(
      desiredOriginalKey,
      contentTypeForFormat(originalFormat),
      media
    );
    assets.original = desiredOriginalKey;
  }

  await persistRememeS3Result(r, assets, {
    status: RememeS3ProcessingStatus.UNSUPPORTED,
    error: `Unsupported rememe media format: ${originalFormat}`
  });
}

async function persistRasterRememe(
  r: Rememe,
  imageUrl: string,
  originalFormat: string,
  existingAssets: RememeAssetKeys
) {
  const derivativeFormat = originalFormat === 'gif' ? 'gif' : 'webp';
  const desiredKeys = getRememeDesiredKeys(r, originalFormat, derivativeFormat);
  const assets = { ...existingAssets };

  if (!hasCompleteRasterAssetSet(assets)) {
    logger.info(
      `[PARTIAL OR MISSING REMEME S3 ASSETS] [CONTRACT ${r.contract}] [ID ${r.id}] [original=${Boolean(
        assets.original
      )}] [scaled=${Boolean(assets.scaled)}] [thumbnail=${Boolean(
        assets.thumbnail
      )}] [icon=${Boolean(assets.icon)}]`
    );

    try {
      const media = await fetchRememeMedia(imageUrl, originalFormat);
      if (!assets.original) {
        await handleObjectUpload(
          desiredKeys.original,
          contentTypeForFormat(originalFormat),
          media
        );
        assets.original = desiredKeys.original;
      }

      await uploadMissingRememeDerivatives(
        r,
        media,
        derivativeFormat,
        desiredKeys,
        assets
      );
    } catch (error) {
      const status = assets.original
        ? RememeS3ProcessingStatus.PARTIAL
        : retryStatusFor(r);
      await persistRememeS3Result(r, assets, {
        status,
        error
      });
      return;
    }
  }

  const currentAssets = await findExistingRememeAssets(r);
  const mergedAssets = mergeAssetKeys(assets, currentAssets);
  const status = hasCompleteRasterAssetSet(mergedAssets)
    ? RememeS3ProcessingStatus.COMPLETE
    : RememeS3ProcessingStatus.PARTIAL;
  const error =
    status === RememeS3ProcessingStatus.PARTIAL
      ? 'Rememe has an original image but one or more resized derivatives are missing'
      : undefined;

  await persistRememeS3Result(r, mergedAssets, {
    status,
    error
  });
}

async function uploadMissingRememeDerivatives(
  r: Rememe,
  sourceBuffer: Buffer,
  derivativeFormat: string,
  desiredKeys: RememeDesiredKeys,
  assets: RememeAssetKeys
) {
  if (!assets.scaled) {
    const scaledBuffer = await resizeImage(
      r,
      derivativeFormat === 'webp',
      sourceBuffer,
      SCALED_HEIGHT
    );
    if (scaledBuffer) {
      await handleObjectUpload(
        desiredKeys.scaled,
        contentTypeForFormat(derivativeFormat),
        scaledBuffer
      );
      assets.scaled = desiredKeys.scaled;
    }
  }

  if (!assets.thumbnail) {
    const thumbnailBuffer = await resizeImage(
      r,
      derivativeFormat === 'webp',
      sourceBuffer,
      THUMBNAIL_HEIGHT
    );
    if (thumbnailBuffer) {
      await handleObjectUpload(
        desiredKeys.thumbnail,
        contentTypeForFormat(derivativeFormat),
        thumbnailBuffer
      );
      assets.thumbnail = desiredKeys.thumbnail;
    }
  }

  if (!assets.icon) {
    const iconBuffer = await resizeImage(
      r,
      derivativeFormat === 'webp',
      sourceBuffer,
      ICON_HEIGHT
    );
    if (iconBuffer) {
      await handleObjectUpload(
        desiredKeys.icon,
        contentTypeForFormat(derivativeFormat),
        iconBuffer
      );
      assets.icon = desiredKeys.icon;
    }
  }
}

function getRememeDesiredKeys(
  r: Rememe,
  originalFormat: string,
  derivativeFormat: string
): RememeDesiredKeys {
  return {
    original: getOriginalKey(r, originalFormat),
    scaled: `rememes/images/scaled/${r.contract}-${r.id}.${derivativeFormat}`,
    thumbnail: `rememes/images/thumbnail/${r.contract}-${r.id}.${derivativeFormat}`,
    icon: `rememes/images/icon/${r.contract}-${r.id}.${derivativeFormat}`
  };
}

function getOriginalKey(r: Rememe, originalFormat: string) {
  return `rememes/images/original/${r.contract}-${r.id}.${originalFormat}`;
}

async function findExistingRememeAssets(r: Rememe): Promise<RememeAssetKeys> {
  const baseKey = `${r.contract}-${r.id}.`;
  const [original, scaled, thumbnail, icon] = await Promise.all([
    findExistingObjectKey(`rememes/images/original/${baseKey}`),
    findExistingObjectKey(`rememes/images/scaled/${baseKey}`),
    findExistingObjectKey(`rememes/images/thumbnail/${baseKey}`),
    findExistingObjectKey(`rememes/images/icon/${baseKey}`)
  ]);

  return { original, scaled, thumbnail, icon };
}

async function findExistingObjectKey(prefix: string): Promise<string | null> {
  const response = await s3.send(
    new ListObjectsV2Command({
      Bucket: myBucket,
      Prefix: prefix,
      MaxKeys: LIST_OBJECTS_MAX_KEYS
    })
  );
  const keys =
    response.Contents?.map((object) => object.Key)
      .filter((key): key is string => Boolean(key))
      .map(stripTemporarySuffix) ?? [];

  return pickPreferredObjectKey(Array.from(new Set(keys)));
}

function pickPreferredObjectKey(keys: string[]): string | null {
  const sortedKeys = [...keys].sort((a, b) => {
    const extensionDiff =
      extensionRank(getFormatFromKey(a)) - extensionRank(getFormatFromKey(b));
    return extensionDiff === 0 ? a.localeCompare(b) : extensionDiff;
  });
  return sortedKeys[0] ?? null;
}

function extensionRank(format: string | null): number {
  const index = format ? EXTENSION_PRIORITY.indexOf(format) : -1;
  return index >= 0 ? index : EXTENSION_PRIORITY.length;
}

function stripTemporarySuffix(key: string) {
  return key.endsWith('__temp') ? key.slice(0, -'__temp'.length) : key;
}

function hasCompleteRasterAssetSet(assets: RememeAssetKeys) {
  return Boolean(
    assets.original && assets.scaled && assets.thumbnail && assets.icon
  );
}

function mergeAssetKeys(
  preferred: RememeAssetKeys,
  fallback: RememeAssetKeys
): RememeAssetKeys {
  return {
    original: preferred.original ?? fallback.original,
    scaled: preferred.scaled ?? fallback.scaled,
    thumbnail: preferred.thumbnail ?? fallback.thumbnail,
    icon: preferred.icon ?? fallback.icon
  };
}

async function fetchRememeMedia(
  imageUrl: string,
  expectedFormat: string
): Promise<Buffer> {
  const response: Response = await withArweaveFallback(imageUrl, (u) =>
    fetch(u, { timeout: FETCH_TIMEOUT_MS })
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch rememe media: ${response.status} ${response.statusText}`
    );
  }

  return await readResponseBufferWithLimit(response, expectedFormat);
}

async function readResponseBufferWithLimit(
  response: Response,
  expectedFormat: string
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_REMEME_MEDIA_BYTES) {
      throw new Error(
        `Rememe ${expectedFormat} media too large (${parsed} bytes > ${MAX_REMEME_MEDIA_BYTES})`
      );
    }
  }

  if (!response.body) {
    const blob = await response.arrayBuffer();
    if (blob.byteLength > MAX_REMEME_MEDIA_BYTES) {
      throw new Error(
        `Rememe ${expectedFormat} media exceeded max size of ${MAX_REMEME_MEDIA_BYTES} bytes`
      );
    }
    return Buffer.from(blob);
  }

  // node-fetch v2 response.body is a Node Readable: async-iterable and destroyable.
  const stream = response.body as unknown as AsyncIterable<unknown>;
  const destroyableStream = response.body as unknown as {
    destroy?: () => void;
  };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = chunkToBuffer(chunk);
    total += buffer.byteLength;
    if (total > MAX_REMEME_MEDIA_BYTES) {
      destroyableStream.destroy?.();
      throw new Error(
        `Rememe ${expectedFormat} media exceeded max size of ${MAX_REMEME_MEDIA_BYTES} bytes`
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, total);
}

function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk), 'utf8');
}

async function persistRememeS3Result(
  r: Rememe,
  assets: RememeAssetKeys,
  result: {
    status: RememeS3ProcessingStatus;
    error?: unknown;
  }
) {
  r.s3_image_original = assetUrl(assets.original);
  r.s3_image_scaled = assetUrl(assets.scaled);
  r.s3_image_thumbnail = assetUrl(assets.thumbnail);
  r.s3_image_icon = assetUrl(assets.icon);
  r.s3_image_processing_status = result.status;
  r.s3_image_processing_error = result.error
    ? truncateProcessingError(toErrorMessage(result.error))
    : null;
  r.s3_image_last_attempt_at = new Date();
  r.s3_image_processing_attempts = nextAttemptCount(r, result.status);

  await persistRememes([r]);
}

function assetUrl(key: string | null): string | null {
  return key ? `${cloudfrontPrefix()}${key}` : null;
}

function nextAttemptCount(r: Rememe, status: RememeS3ProcessingStatus): number {
  const currentAttempts = r.s3_image_processing_attempts ?? 0;
  if (
    status === RememeS3ProcessingStatus.COMPLETE ||
    status === RememeS3ProcessingStatus.UNSUPPORTED
  ) {
    return currentAttempts;
  }
  return currentAttempts + 1;
}

function retryStatusFor(r: Rememe): RememeS3ProcessingStatus {
  const nextAttempt = (r.s3_image_processing_attempts ?? 0) + 1;
  return nextAttempt >= REMEME_S3_MAX_PROCESSING_ATTEMPTS
    ? RememeS3ProcessingStatus.PERMANENT_ERROR
    : RememeS3ProcessingStatus.TRANSIENT_ERROR;
}

function emptyAssetKeysFromRememe(r: Rememe): RememeAssetKeys {
  return {
    original: keyFromAssetUrl(r.s3_image_original),
    scaled: keyFromAssetUrl(r.s3_image_scaled),
    thumbnail: keyFromAssetUrl(r.s3_image_thumbnail),
    icon: keyFromAssetUrl(r.s3_image_icon)
  };
}

function keyFromAssetUrl(assetUrlValue?: string | null): string | null {
  const prefix = cloudfrontPrefix();
  if (!assetUrlValue?.startsWith(prefix)) {
    return null;
  }
  return assetUrlValue.slice(prefix.length);
}

function cloudfrontPrefix(): string {
  return CLOUDFRONT_LINK.endsWith('/')
    ? CLOUDFRONT_LINK
    : `${CLOUDFRONT_LINK}/`;
}

async function handleObjectUpload(
  key: string,
  contentType: string,
  blob: Buffer
) {
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: key,
      Body: blob,
      ContentType: contentType
    })
  );

  logger.info(`[UPLOADED ${key}] [STATUS ${put.$metadata.httpStatusCode}]`);
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
  } catch (err) {
    logger.error(
      `[RESIZING FOR ${rememe.contract} #${rememe.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}

function normalizeFormat(format?: string | null): string | null {
  if (!format) {
    return null;
  }
  const normalized = format.toLowerCase().split(';')[0]?.trim();
  if (!normalized) {
    return null;
  }
  const subtype = normalized.includes('/')
    ? normalized.split('/').pop()?.trim()
    : normalized;
  if (!subtype) {
    return null;
  }
  if (subtype === 'svg+xml') {
    return 'svg';
  }
  return subtype;
}

function getFormatFromKey(key?: string | null): string | null {
  if (!key) {
    return null;
  }
  const stripped = stripTemporarySuffix(key);
  const fileName = stripped.slice(stripped.lastIndexOf('/') + 1);
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) {
    return null;
  }
  return normalizeFormat(fileName.slice(dotIndex + 1));
}

function isRasterImageFormat(format: string): boolean {
  return RASTER_IMAGE_FORMATS.has(format);
}

function contentTypeForFormat(format: string) {
  if (format === 'jpg' || format === 'jpeg') {
    return 'image/jpeg';
  }
  if (format === 'mp4') {
    return 'video/mp4';
  }
  if (format === 'webm') {
    return 'video/webm';
  }
  if (format === 'mov') {
    return 'video/quicktime';
  }
  return `image/${format}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateProcessingError(error: string): string {
  return error.length > PROCESSING_ERROR_MAX_LENGTH
    ? error.slice(0, PROCESSING_ERROR_MAX_LENGTH)
    : error;
}

function redactUrlForLog(url: string): string {
  if (url.length <= 160) {
    return url;
  }
  return `${url.slice(0, 157)}...`;
}
