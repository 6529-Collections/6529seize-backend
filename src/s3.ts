import { NFT } from './entities/INFT';
import { s3ObjectExists, s3UploadObject } from './helpers/s3_helpers';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import sharp from 'sharp';
import { Stream } from 'stream';
import { Logger } from './logging';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import pLimit from 'p-limit';
import { invalidateCloudFront } from './cloudfront';
import { equalIgnoreCase } from './strings';

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

const imagescript = require('imagescript');

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;

const cfInvalidationPaths = new Set<string>();

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

export const persistS3 = async (nfts: NFT[]) => {
  logger.info(`[PROCESSING ASSETS FOR ${nfts.length} NFTS]`);
  const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;
  const myDistribution = process.env.AWS_6529_IMAGES_BUCKET_CF_DISTRIBUTION;

  const flushInterval = setInterval(() => {
    flushCloudfront(myDistribution).catch((err) =>
      logger.error('Flush failed', err)
    );
  }, 300_000); // 5 minutes

  try {
    await Promise.all(
      nfts.map((nft) => limit(() => processNft(myBucket, nft)))
    );
  } finally {
    clearInterval(flushInterval);
    await flushCloudfront(myDistribution);
  }
};

async function processNft(myBucket: string, n: NFT) {
  let format: any;
  if (
    equalIgnoreCase(n.contract, MEMES_CONTRACT) ||
    equalIgnoreCase(n.contract, MEMELAB_CONTRACT)
  ) {
    format = n.metadata.image_details.format;
  }
  if (equalIgnoreCase(n.contract, GRADIENT_CONTRACT)) {
    format = n.metadata.image.split('.').pop();
  }

  const imageUrl = n.metadata.image ?? n.metadata.image_url;

  if (format && imageUrl) {
    const imageTxId = getTxId(imageUrl, `${n.contract}-${n.id}`);
    const imageKey = `images/original/${n.contract}/${n.id}.${format}`;

    await handleImage({
      nft: n,
      format,
      s3Key: imageKey,
      height: null,
      toWEBP: false,
      contentType: `image/${format.toLowerCase()}`,
      imageTxId,
      myBucket
    });

    await Promise.all([
      n.scaled &&
        handleScaledImage({
          nft: n,
          format,
          height: SCALED_HEIGHT,
          imageTxId,
          myBucket
        }),
      n.thumbnail &&
        handleScaledImage({
          nft: n,
          format,
          height: THUMBNAIL_HEIGHT,
          imageTxId,
          myBucket
        }),
      n.icon &&
        handleScaledImage({
          nft: n,
          format,
          height: ICON_HEIGHT,
          imageTxId,
          myBucket
        })
    ]);
  }

  const videoUrl = n.metadata.animation ?? n.metadata.animation_url;
  const animationDetails = n.metadata.animation_details;

  if (
    videoUrl &&
    (animationDetails?.format?.toUpperCase() == 'MP4' ||
      animationDetails?.format?.toUpperCase() == 'MOV')
  ) {
    const videoTxId = getTxId(videoUrl, `${n.contract}-${n.id}`);
    const videoFormat = animationDetails.format.toUpperCase();
    const videoKey = `videos/${n.contract}/${n.id}.${videoFormat}`;

    const videoExists = await s3ObjectExists(myBucket, videoKey, videoTxId);
    if (videoExists.exists) return;

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

    await handleVideoScaling(n, videoUrl, videoFormat, myBucket, videoTxId);
  }
}

async function handleScaledImage({
  nft,
  format,
  height,
  imageTxId,
  myBucket
}: {
  nft: NFT;
  format: string;
  height: number;
  imageTxId: string;
  myBucket: string;
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
    myBucket
  });
}

async function handleImage({
  nft,
  s3Key,
  height,
  toWEBP,
  contentType,
  imageTxId,
  myBucket
}: {
  nft: NFT;
  format: string;
  s3Key: string;
  height: number | null;
  toWEBP: boolean;
  contentType: string;
  imageTxId: string;
  myBucket: string;
}) {
  const imageExists = await s3ObjectExists(myBucket, s3Key, imageTxId);
  if (imageExists.exists) return;

  logger.info(
    `[MISSING IMAGE FOR HEIGHT ${height ?? 'original'}] [KEY ${s3Key}]`
  );

  const url = nft.metadata.image ?? nft.metadata.image_url;
  const blob = await fetchUrl(url);
  logger.info(`[DOWNLOADED FOR HEIGHT ${height ?? 'original'}] [KEY ${s3Key}]`);

  let buffer: Buffer;
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
  n: NFT,
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
  nft: NFT,
  toWEBP: boolean,
  buffer: Buffer,
  height: number
) {
  logger.info(
    `[RESIZING FOR ${nft.contract} #${nft.id} (WEBP: ${toWEBP})] [TO TARGET HEIGHT ${height}]`
  );
  try {
    if (toWEBP) {
      return await sharp(buffer).resize({ height: height }).webp().toBuffer();
    } else {
      const gif = await imagescript.GIF.decode(buffer);
      const scaleFactor = gif.height / height;
      gif.resize(gif.width / scaleFactor, height);
      return gif.encode();
    }
  } catch (err: any) {
    logger.error(
      `[RESIZING FOR ${nft.contract} #${nft.id}] [TO TARGET HEIGHT ${height}] [FAILED!]`,
      err
    );
  }
}
