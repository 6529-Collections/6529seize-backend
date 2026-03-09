import { LabNFT, NFT } from '@/entities/INFT';
import { s3ObjectExists, s3UploadObject } from './helpers/s3_helpers';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { Stream } from 'stream';
import { Logger } from './logging';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import pLimit from 'p-limit';
import { invalidateCloudFront } from './cloudfront';
import { equalIgnoreCase } from './strings';
import { Time } from '@/time';
import {
  S3UploaderImageVariant,
  S3UploaderJob,
  S3UploaderJobType,
  S3UploaderVideoVariant
} from '@/s3Uploader/s3-uploader.jobs';
import { resizeImageBufferToHeight } from '@/media/image-resize';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { assertUnreachable } from '@/assertions';

const logger = Logger.get('S3');
const limit = pLimit(3);

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkError(error) ??
      axiosRetry.isRetryableError(error) ??
      (error.response?.status ?? 0) >= 500
    );
  }
});

const fetchUrl = async (url: string): Promise<Buffer> => {
  const fetchOne = async (u: string) => {
    const response = await axios.get(u, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  };
  return withArweaveFallback(url, fetchOne);
};

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;

const cfInvalidationPaths = new Set<string>();
type ProcessableNft = NFT | LabNFT;

const flushCloudfront = async (distribution?: string) => {
  if (!distribution) return;

  if (cfInvalidationPaths.size > 0) {
    const paths = Array.from(cfInvalidationPaths);
    cfInvalidationPaths.clear();

    logger.info(
      `[FLUSH] Triggering CloudFront invalidation for ${paths.length} paths`
    );
    await invalidateCloudFront(distribution, paths);
  }
};

function parseAnimationDetails(value: any): { format?: string } | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export const getTxId = (url: string, fallback: string): string => {
  try {
    const parsed = new URL(url);
    // Arweave: https://arweave.net/<txId>
    if (parsed.hostname.includes('arweave.net')) {
      const parts = parsed.pathname.split('/');
      if (parts.length >= 2 && parts[1]) {
        return parts[1];
      }
    }

    // IPFS: https://.../ipfs/<cid>/...
    const ipfsMatch = parsed.pathname.match(/\/ipfs\/([^/]+)/);
    if (ipfsMatch) {
      return ipfsMatch[1];
    }
  } catch (err) {
    logger.warn(`[ERROR GETTING TX ID FROM URL: ${url}]`, err);
  }

  return fallback;
};

async function withCloudfrontFlush<T>(work: (myBucket: string) => Promise<T>) {
  const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;
  const myDistribution = process.env.AWS_6529_IMAGES_BUCKET_CF_DISTRIBUTION;

  const flushInterval = setInterval(async () => {
    try {
      await flushCloudfront(myDistribution);
    } catch (err) {
      logger.error('Flush failed', err);
    }
  }, Time.minutes(5).toMillis());

  try {
    return await work(myBucket);
  } finally {
    clearInterval(flushInterval);
    await flushCloudfront(myDistribution);
  }
}

export const persistS3 = async (nfts: ProcessableNft[]) => {
  logger.info(`[PROCESSING ASSETS FOR ${nfts.length} NFTS]`);
  let results: PromiseSettledResult<void>[] = [];
  await withCloudfrontFlush(async (myBucket) => {
    results = await Promise.allSettled(
      nfts.map((nft) => limit(() => processNft(myBucket, nft)))
    );
  });

  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) {
    throw failed.reason;
  }
};

export async function processS3UploaderJob(
  nft: ProcessableNft,
  job: S3UploaderJob
) {
  await withCloudfrontFlush(async (myBucket) => {
    const jobType = job.jobType;
    switch (jobType) {
      case S3UploaderJobType.IMAGE:
        await processNftImages(myBucket, nft, job.variants);
        return;
      case S3UploaderJobType.VIDEO:
        await processNftVideos(myBucket, nft, job.variants);
        return;
      default:
        logger.warn(`[UNKNOWN JOB TYPE] [${jobType}]`);
        throw assertUnreachable(jobType);
    }
  });
}

async function processNft(myBucket: string, n: ProcessableNft) {
  await processNftImages(myBucket, n);
  await processNftVideos(myBucket, n);
}

async function processNftImages(
  myBucket: string,
  n: ProcessableNft,
  imageVariants?: S3UploaderImageVariant[]
) {
  const imageDetails = getProcessableImageDetails(n, imageVariants);
  if (!imageDetails) {
    return;
  }

  const { format, imageUrl, requestedVariants } = imageDetails;
  const imageTxId = getTxId(imageUrl, `${n.contract}-${n.id}`);
  const imageKey = `images/original/${n.contract}/${n.id}.${format}`;
  const getImageBlob = createImageBlobProvider(imageUrl);

  await maybeHandleOriginalImage({
    requestedVariants,
    nft: n,
    format,
    imageKey,
    imageTxId,
    myBucket,
    getImageBlob
  });

  await processScaledImageVariants({
    nft: n,
    format,
    imageTxId,
    myBucket,
    requestedVariants,
    getImageBlob
  });
}

function getProcessableImageDetails(
  n: ProcessableNft,
  imageVariants?: S3UploaderImageVariant[]
): {
  format: string;
  imageUrl: string;
  requestedVariants: Set<S3UploaderImageVariant>;
} | null {
  const format = resolveNftImageFormat(n);
  const imageUrl = n.metadata?.image ?? n.metadata?.image_url;
  if (!imageUrl) {
    logger.info(
      `[SKIP IMAGE] [${n.contract}#${n.id}] [reason=missing_image_url]`
    );
    return null;
  }
  if (!format) {
    logger.info(
      `[SKIP IMAGE] [${n.contract}#${n.id}] [reason=unsupported_or_missing_image_format]`
    );
    return null;
  }

  return {
    format,
    imageUrl,
    requestedVariants: new Set<S3UploaderImageVariant>(
      imageVariants ?? [
        S3UploaderImageVariant.ORIGINAL,
        ...(n.scaled ? [S3UploaderImageVariant.SCALED_1000] : []),
        ...(n.thumbnail ? [S3UploaderImageVariant.SCALED_450] : []),
        ...(n.icon ? [S3UploaderImageVariant.SCALED_60] : [])
      ]
    )
  };
}

function resolveNftImageFormat(n: ProcessableNft): string | null {
  if (
    equalIgnoreCase(n.contract, MEMES_CONTRACT) ||
    equalIgnoreCase(n.contract, MEMELAB_CONTRACT)
  ) {
    return n.metadata?.image_details?.format ?? null;
  }
  if (equalIgnoreCase(n.contract, GRADIENT_CONTRACT)) {
    return n.metadata?.image?.split?.('.').pop() ?? null;
  }
  return null;
}

function createImageBlobProvider(imageUrl: string) {
  let cachedBlob: Buffer | null = null;
  let inFlightPromise: Promise<Buffer> | null = null;
  return async () => {
    if (cachedBlob) {
      return cachedBlob;
    }

    inFlightPromise ??= (async () => {
      try {
        const blob = await fetchUrl(imageUrl);
        cachedBlob = blob;
        return blob;
      } catch (err) {
        inFlightPromise = null;
        throw err;
      }
    })();

    const currentPromise = inFlightPromise;
    try {
      return await currentPromise;
    } finally {
      if (cachedBlob && inFlightPromise === currentPromise) {
        inFlightPromise = null;
      }
    }
  };
}

async function maybeHandleOriginalImage({
  requestedVariants,
  nft,
  format,
  imageKey,
  imageTxId,
  myBucket,
  getImageBlob
}: {
  requestedVariants: Set<S3UploaderImageVariant>;
  nft: ProcessableNft;
  format: string;
  imageKey: string;
  imageTxId: string;
  myBucket: string;
  getImageBlob: () => Promise<Buffer>;
}) {
  if (!requestedVariants.has(S3UploaderImageVariant.ORIGINAL)) {
    logger.info(
      `[SKIP IMAGE ORIGINAL] [${nft.contract}#${nft.id}] [reason=variant_not_requested]`
    );
    return;
  }

  await handleImage({
    nft,
    format,
    s3Key: imageKey,
    height: null,
    toWEBP: false,
    contentType: `image/${format.toLowerCase()}`,
    imageTxId,
    myBucket,
    sourceBlobProvider: getImageBlob
  });
}

async function processScaledImageVariants({
  nft,
  format,
  imageTxId,
  myBucket,
  requestedVariants,
  getImageBlob
}: {
  nft: ProcessableNft;
  format: string;
  imageTxId: string;
  myBucket: string;
  requestedVariants: Set<S3UploaderImageVariant>;
  getImageBlob: () => Promise<Buffer>;
}) {
  const tasks: Array<Promise<unknown>> = [];

  if (nft.scaled && requestedVariants.has(S3UploaderImageVariant.SCALED_1000)) {
    tasks.push(
      handleScaledImage({
        nft,
        format,
        height: SCALED_HEIGHT,
        imageTxId,
        myBucket,
        sourceBlobProvider: getImageBlob
      })
    );
  }
  if (
    nft.thumbnail &&
    requestedVariants.has(S3UploaderImageVariant.SCALED_450)
  ) {
    tasks.push(
      handleScaledImage({
        nft,
        format,
        height: THUMBNAIL_HEIGHT,
        imageTxId,
        myBucket,
        sourceBlobProvider: getImageBlob
      })
    );
  }
  if (nft.icon && requestedVariants.has(S3UploaderImageVariant.SCALED_60)) {
    tasks.push(
      handleScaledImage({
        nft,
        format,
        height: ICON_HEIGHT,
        imageTxId,
        myBucket,
        sourceBlobProvider: getImageBlob
      })
    );
  }

  if (tasks.length) {
    await Promise.all(tasks);
  } else {
    logger.info(
      `[SKIP IMAGE SCALES] [${nft.contract}#${nft.id}] [reason=no_requested_or_available_scaled_variants]`
    );
  }
}

async function processNftVideos(
  myBucket: string,
  n: ProcessableNft,
  videoVariants?: S3UploaderVideoVariant[]
) {
  const videoUrl = n.metadata?.animation ?? n.metadata?.animation_url;
  const animationDetails = parseAnimationDetails(n.metadata?.animation_details);
  const rawFormat = animationDetails?.format;
  const normalizedFormat =
    typeof rawFormat === 'string' ? rawFormat.trim().toUpperCase() : '';

  if (!videoUrl) {
    logger.info(
      `[SKIP VIDEO] [${n.contract}#${n.id}] [reason=missing_video_url]`
    );
    return;
  }
  if (normalizedFormat !== 'MP4' && normalizedFormat !== 'MOV') {
    logger.info(
      `[SKIP VIDEO] [${n.contract}#${n.id}] [reason=unsupported_or_missing_video_format] [format=${rawFormat ?? ''}]`
    );
    return;
  }

  const requestedVariants = new Set<S3UploaderVideoVariant>(
    videoVariants ?? [
      S3UploaderVideoVariant.ORIGINAL,
      S3UploaderVideoVariant.SCALED_750
    ]
  );
  const videoTxId = getTxId(videoUrl, `${n.contract}-${n.id}`);
  const videoFormat = normalizedFormat;
  const videoKey = `videos/${n.contract}/${n.id}.${videoFormat}`;

  if (requestedVariants.has(S3UploaderVideoVariant.ORIGINAL)) {
    const videoExists = await s3ObjectExists(myBucket, videoKey, videoTxId);
    if (!videoExists.exists) {
      logger.info(`[MISSING ${videoFormat}] [KEY ${videoKey}]`);
      logger.info(`[FETCHING ${videoFormat}] [KEY ${videoKey}]`);

      const buffer = await fetchUrl(videoUrl);
      logger.info(`[DOWNLOADED ${videoFormat}] [KEY ${videoKey}]`);

      const uploadedVideo = await s3UploadObject({
        bucket: myBucket,
        key: videoKey,
        body: buffer,
        contentType: `video/${videoFormat.toLowerCase()}`,
        txId: videoTxId
      });

      logger.info(`[KEY UPLOADED ${videoKey}] [ETAG ${uploadedVideo.ETag}]`);
      cfInvalidationPaths.add(`/${videoKey}`);
    } else {
      logger.info(
        `[SKIP VIDEO ORIGINAL] [KEY ${videoKey}] [reason=already_exists]`
      );
    }
  } else {
    logger.info(
      `[SKIP VIDEO ORIGINAL] [${n.contract}#${n.id}] [reason=variant_not_requested]`
    );
  }

  if (requestedVariants.has(S3UploaderVideoVariant.SCALED_750)) {
    await handleVideoScaling(n, videoUrl, videoFormat, myBucket, videoTxId);
  } else {
    logger.info(
      `[SKIP VIDEO SCALED_750] [${n.contract}#${n.id}] [reason=variant_not_requested]`
    );
  }
}

async function handleScaledImage({
  nft,
  format,
  height,
  imageTxId,
  myBucket,
  sourceBlobProvider
}: {
  nft: ProcessableNft;
  format: string;
  height: number;
  imageTxId: string;
  myBucket: string;
  sourceBlobProvider?: () => Promise<Buffer>;
}) {
  let scaledFormat = 'WEBP';
  if (format.toUpperCase() == 'GIF') {
    scaledFormat = 'GIF';
  }

  const scaledKey = `images/scaled_x${height}/${nft.contract}/${nft.id}.${scaledFormat}`;
  await handleImage({
    nft: nft,
    format,
    s3Key: scaledKey,
    height: height,
    toWEBP: scaledFormat == 'WEBP',
    contentType: `image/${scaledFormat.toLowerCase()}`,
    imageTxId,
    myBucket,
    sourceBlobProvider
  });
}

async function handleImage({
  nft,
  s3Key,
  height,
  toWEBP,
  contentType,
  imageTxId,
  myBucket,
  sourceBlobProvider
}: {
  nft: ProcessableNft;
  format: string;
  s3Key: string;
  height: number | null;
  toWEBP: boolean;
  contentType: string;
  imageTxId: string;
  myBucket: string;
  sourceBlobProvider?: () => Promise<Buffer>;
}) {
  const imageExists = await s3ObjectExists(myBucket, s3Key, imageTxId);
  if (imageExists.exists) {
    logger.info(`[SKIP IMAGE] [KEY ${s3Key}] [reason=already_exists]`);
    return;
  }

  logger.info(
    `[MISSING IMAGE FOR HEIGHT ${height ?? 'original'}] [KEY ${s3Key}]`
  );

  const url = nft.metadata?.image ?? nft.metadata?.image_url;
  const imageUrl = typeof url === 'string' ? url.trim() : '';
  if (!sourceBlobProvider && !imageUrl) {
    throw new Error(`Missing image URL for NFT ${nft.contract} #${nft.id}`);
  }
  const blob = sourceBlobProvider
    ? await sourceBlobProvider()
    : await fetchUrl(imageUrl);
  logger.info(`[DOWNLOADED FOR HEIGHT ${height ?? 'original'}] [KEY ${s3Key}]`);

  let buffer: Buffer | undefined;
  if (!height) {
    buffer = blob;
  } else {
    buffer = await resizeImage(nft, toWEBP, blob, height);
  }

  if (!buffer) {
    logger.error(`[BUFFER IS EMPTY] [KEY ${s3Key}]`);
    return;
  }

  const result = await s3UploadObject({
    bucket: myBucket,
    key: s3Key,
    body: buffer,
    contentType,
    txId: imageTxId
  });

  logger.info(`[KEY UPLOADED ${s3Key}] [ETAG ${result.ETag}]`);
  cfInvalidationPaths.add(`/${s3Key}`);
}

async function handleVideoScaling(
  n: ProcessableNft,
  videoUrl: string,
  videoFormat: string,
  myBucket: string,
  txId: string
) {
  const scaledVideoKey = `videos/${n.contract}/scaledx750/${n.id}.${videoFormat}`;

  const videoExists = await s3ObjectExists(myBucket, scaledVideoKey, txId);
  if (videoExists.exists) {
    logger.info(
      `[SKIP VIDEO SCALED] [KEY ${scaledVideoKey}] [reason=already_exists]`
    );
    return;
  }

  logger.info(`[MISSING SCALED ${videoFormat}] [KEY ${scaledVideoKey}]`);

  logger.info(`[SCALING ${scaledVideoKey}]`);
  let resizedVideoStream: NodeJS.ReadableStream;
  try {
    resizedVideoStream = await scaleVideo(videoUrl, videoFormat.toLowerCase());
  } catch (err) {
    logger.error(`[scaleVideo FAILED] [${scaledVideoKey}]`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }

  logger.info(`[ACQUIRED SCALED STREAM ${scaledVideoKey}]`);

  let totalChunks = 0;
  let totalBytes = 0;
  const countingStream = new Stream.Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalChunks++;
      totalBytes += buf.length;
      callback(null, buf);
    }
  });

  resizedVideoStream.on('error', (err) => {
    logger.error(
      `[resizedVideoStream] [SCALING FAILED ${scaledVideoKey}]`,
      err
    );
    countingStream.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  resizedVideoStream.pipe(countingStream, { end: true });

  try {
    const uploadedScaledVideo = await s3UploadObject({
      bucket: myBucket,
      key: scaledVideoKey,
      body: countingStream,
      contentType: `video/${videoFormat.toLowerCase()}`,
      txId
    });

    logger.info(
      `[S3] [SCALING STREAM SUMMARY ${scaledVideoKey}] [chunks ${totalChunks}] [bytes ${totalBytes}]`
    );
    logger.info(
      `[KEY UPLOADED ${scaledVideoKey}] [ETAG ${uploadedScaledVideo.ETag}]`
    );
    cfInvalidationPaths.add(`/${scaledVideoKey}`);
  } catch (e) {
    logger.error(`[UPLOAD FAILED ${scaledVideoKey}]`, e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

async function scaleVideo(
  url: string,
  format: string
): Promise<NodeJS.ReadableStream> {
  const ff = ffmpeg({ source: url })
    .videoCodec('libx264')
    .audioCodec('aac')
    .inputFormat(format)
    .outputFormat(format)
    .outputOptions([
      '-filter:v scale=-1:750,scale=trunc(iw/2)*2:750',
      '-crf 25',
      '-movflags frag_keyframe+empty_moov'
    ]);
  if (url.endsWith('30.MP4')) {
    logger.info(`[SPECIAL CASE 30.MP4`);
    ff.outputOptions(['-filter:v scale=750:-1']);
  }
  return ff;
}

async function resizeImage(
  nft: ProcessableNft,
  toWEBP: boolean,
  buffer: Buffer,
  height: number
): Promise<Buffer | undefined> {
  logger.info(
    `[RESIZING FOR ${nft.contract} #${nft.id} (WEBP: ${toWEBP})] [TO TARGET HEIGHT ${height}]`
  );
  try {
    return await resizeImageBufferToHeight({
      buffer,
      height,
      toWebp: toWEBP
    });
  } catch (err: any) {
    logger.error(
      `[RESIZING FOR ${nft.contract} #${nft.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}
