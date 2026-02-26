import { LabNFT, NFT } from './entities/INFT';
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
  const response = await axios.get(url, {
    responseType: 'arraybuffer'
  });

  return Buffer.from(response.data);
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
    if (job.jobType === S3UploaderJobType.IMAGE) {
      await processNftImages(myBucket, nft, job.variants);
      return;
    }

    await processNftVideos(myBucket, nft, job.variants);
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
  if (!format || !imageUrl) {
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

    inFlightPromise ??= fetchUrl(imageUrl)
      .then((blob) => {
        cachedBlob = blob;
        return blob;
      })
      .catch((err) => {
        inFlightPromise = null;
        throw err;
      });

    const blob = await inFlightPromise;
    inFlightPromise = null;
    return blob;
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

  if (videoUrl && (normalizedFormat == 'MP4' || normalizedFormat == 'MOV')) {
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
      }
    }

    if (requestedVariants.has(S3UploaderVideoVariant.SCALED_750)) {
      await handleVideoScaling(n, videoUrl, videoFormat, myBucket, videoTxId);
    }
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
  if (imageExists.exists) return;

  logger.info(
    `[MISSING IMAGE FOR HEIGHT ${height ?? 'original'}] [KEY ${s3Key}]`
  );

  const url = nft.metadata?.image ?? nft.metadata?.image_url;
  const blob = sourceBlobProvider
    ? await sourceBlobProvider()
    : await fetchUrl(url);
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
  if (videoExists.exists) return;

  logger.info(`[MISSING SCALED ${videoFormat}] [KEY ${scaledVideoKey}]`);

  logger.info(`[SCALING ${scaledVideoKey}]`);

  await new Promise<void>((resolve, reject) => {
    const buffers: Buffer[] = [];

    scaleVideo(videoUrl, videoFormat.toLowerCase())
      .then((resizedVideoStream) => {
        logger.info(`[ACQUIRED SCALED STREAM ${scaledVideoKey}]`);

        resizedVideoStream.on('error', async (err) => {
          logger.error(
            `[resizedVideoStream] [SCALING FAILED ${scaledVideoKey}]`,
            err
          );
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        const ffstream = new Stream.PassThrough();
        resizedVideoStream.pipe(ffstream, { end: true });

        ffstream.on('data', (buf) => {
          logger.info(
            `[${scaledVideoKey}] [ADDING CHUNK LENGTH ${buf.length}]`
          );
          if (buf.length > 0) buffers.push(buf);
        });

        ffstream.on('error', async (err) => {
          logger.error(`[SCALING FAILED ${scaledVideoKey}]`, err);
          reject(err instanceof Error ? err : new Error(String(err)));
        });

        ffstream.on('end', async () => {
          logger.info(`[S3] [SCALING FINISHED ${scaledVideoKey}]`);
          try {
            if (buffers.length > 0) {
              const outputBuffer = Buffer.concat(buffers);
              if (!outputBuffer.length) return;

              const uploadedScaledVideo = await s3UploadObject({
                bucket: myBucket,
                key: scaledVideoKey,
                body: outputBuffer,
                contentType: `video/${videoFormat.toLowerCase()}`,
                txId
              });

              logger.info(
                `[KEY UPLOADED ${scaledVideoKey}] [ETAG ${uploadedScaledVideo.ETag}]`
              );
              cfInvalidationPaths.add(`/${scaledVideoKey}`);
            }
            resolve();
          } catch (e) {
            logger.error(`[UPLOAD FAILED ${scaledVideoKey}]`, e);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      })
      .catch((err) => {
        logger.error(`[scaleVideo FAILED] [${scaledVideoKey}]`, err);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
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
      `[RESIZING FOR ${nft.contract} #${nft.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}
