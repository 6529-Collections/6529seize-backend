import { NFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import {
  objectExists,
  createTempFile,
  deleteTempFile
} from './helpers/s3_helpers';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFT_ORIGINAL_IMAGE_LINK
} from './constants';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Stream } from 'stream';
import { RequestInfo, RequestInit } from 'node-fetch';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const imagescript = require('imagescript');

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;

let s3: S3Client;

export const persistS3 = async (nfts: NFT[]) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  console.log('[S3]', `[PROCESSING ASSETS FOR ${nfts.length} NFTS]`);

  const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  await Promise.all(
    nfts.map(async (n) => {
      let format: any;

      if (
        areEqualAddresses(n.contract, MEMES_CONTRACT) ||
        areEqualAddresses(n.contract, MEMELAB_CONTRACT)
      ) {
        format = n.metadata.image_details.format;
      }
      if (areEqualAddresses(n.contract, GRADIENT_CONTRACT)) {
        format = n.metadata.image.split('.').pop();
      }

      if (format) {
        const imageKey = `images/original/${n.contract}/${n.id}.${format}`;
        const imageExists = await objectExists(s3, myBucket, imageKey);

        if (!imageExists) {
          console.log(
            '[S3]',
            `[MISSING IMAGE]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            '[S3]',
            `[FETCHING IMAGE]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const imageURL = n.metadata.image;
          const res = await fetch(imageURL);
          const blob = await res.arrayBuffer();
          console.log(
            '[S3]',
            `[IMAGE DOWNLOADED]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const uploadedImage = await s3.send(
            new PutObjectCommand({
              Bucket: myBucket,
              Key: imageKey,
              Body: Buffer.from(blob),
              ContentType: `image/${format.toLowerCase()}`
            })
          );

          console.log('[S3]', `[IMAGE PERSISTED AT ${uploadedImage.ETag}`);
        }
      }

      if (n.scaled) {
        let scaledFormat = 'WEBP';
        if (format.toUpperCase() == 'GIF') {
          scaledFormat = 'GIF';
        }
        const scaledKey = `images/scaled_x1000/${n.contract}/${n.id}.${scaledFormat}`;
        const scaledImageExists = await objectExists(s3, myBucket, scaledKey);

        if (!scaledImageExists) {
          console.log(
            '[S3]',
            `[MISSING SCALED]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            '[S3]',
            `[FETCHING IMAGE FOR SCALED]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const scaledURL = `${NFT_ORIGINAL_IMAGE_LINK}${n.contract}/${n.id}.${format}`;
          const res = await fetch(scaledURL);
          const blob = await res.arrayBuffer();
          console.log(
            '[S3]',
            `[IMAGE FOR SCALED DOWNLOADED]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const scaledBuffer = await resizeImage(
            n,
            scaledFormat == 'WEBP' ? true : false,
            Buffer.from(blob),
            SCALED_HEIGHT
          );

          const uploadedScaledImage = await s3.send(
            new PutObjectCommand({
              Bucket: myBucket,
              Key: scaledKey,
              Body: scaledBuffer,
              ContentType: `image/${scaledFormat}`
            })
          );

          console.log(
            '[S3]',
            `[SCALED PERSISTED AT ${uploadedScaledImage.ETag}`
          );
        }

        if (n.thumbnail) {
          let thumbnailFormat = 'WEBP';
          if (format.toUpperCase() == 'GIF') {
            thumbnailFormat = 'GIF';
          }
          const thumbnailKey = `images/scaled_x450/${n.contract}/${n.id}.${thumbnailFormat}`;
          const thumbnailExists = await objectExists(
            s3,
            myBucket,
            thumbnailKey
          );

          if (!thumbnailExists) {
            console.log(
              '[S3]',
              `[MISSING THUMBNAIL]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            console.log(
              '[S3]',
              `[FETCHING IMAGE FOR THUMBNAIL]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const thumbnailURL = `${NFT_ORIGINAL_IMAGE_LINK}${n.contract}/${n.id}.${format}`;
            const res = await fetch(thumbnailURL);
            const blob = await res.arrayBuffer();
            console.log(
              '[S3]',
              `[IMAGE FOR THUMBNAIL DOWNLOADED]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const thumbBuffer = await resizeImage(
              n,
              thumbnailFormat == 'WEBP' ? true : false,
              Buffer.from(blob),
              THUMBNAIL_HEIGHT
            );

            const uploadedThumbnail = await s3.send(
              new PutObjectCommand({
                Bucket: myBucket,
                Key: thumbnailKey,
                Body: thumbBuffer,
                ContentType: `image/${thumbnailFormat}`
              })
            );

            console.log(
              '[S3]',
              `[THUMBNAIL PERSISTED AT ${uploadedThumbnail.ETag}`
            );
          }
        }

        if (n.icon) {
          let iconFormat = 'WEBP';
          if (format.toUpperCase() == 'GIF') {
            iconFormat = 'GIF';
          }

          const iconKey = `images/scaled_x60/${n.contract}/${n.id}.${iconFormat}`;
          const iconExists = await objectExists(s3, myBucket, iconKey);

          if (!iconExists) {
            console.log(
              '[S3]',
              `[MISSING ICON]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            await createTempFile(s3, myBucket, iconKey);

            console.log(
              '[S3]',
              `[FETCHING IMAGE FOR ICON]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const iconURL = `${NFT_ORIGINAL_IMAGE_LINK}${n.contract}/${n.id}.${format}`;
            const res = await fetch(iconURL);
            const blob = await res.arrayBuffer();
            console.log(
              '[S3]',
              `[IMAGE FOR ICON DOWNLOADED]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const iconBuffer = await resizeImage(
              n,
              iconFormat == 'WEBP' ? true : false,
              Buffer.from(blob),
              ICON_HEIGHT
            );

            const uploadedIcon = await s3.send(
              new PutObjectCommand({
                Bucket: myBucket,
                Key: iconKey,
                Body: iconBuffer,
                ContentType: `image/${iconFormat}`
              })
            );

            await deleteTempFile(s3, myBucket, iconKey);

            console.log('[S3]', `[ICON PERSISTED AT ${uploadedIcon.ETag}`);
          }
        }
      }

      const animationDetails = n.metadata.animation_details;

      if (animationDetails && animationDetails.format?.toUpperCase() == 'MP4') {
        const videoFormat = animationDetails.format.toUpperCase();
        const videoKey = `videos/${n.contract}/${n.id}.${videoFormat}`;
        const videoExists = await objectExists(s3, myBucket, videoKey);

        if (!videoExists) {
          console.log(
            '[S3]',
            `[MISSING ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            '[S3]',
            `[FETCHING ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const videoURL = n.metadata.animation
            ? n.metadata.animation
            : n.metadata.animation_url;
          const res = await fetch(videoURL);
          const blob = await res.arrayBuffer();
          console.log(
            '[S3]',
            `[DOWNLOADED ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const uploadedVideo = await s3.send(
            new PutObjectCommand({
              Bucket: myBucket,
              Key: videoKey,
              Body: Buffer.from(blob),
              ContentType: `video/mp4`
            })
          );

          console.log(
            '[S3]',
            `[${videoFormat} PERSISTED AT ${uploadedVideo.ETag}`
          );
        }

        await handleVideoScaling(n, videoFormat, myBucket);
      }
    })
  );
};

async function handleVideoScaling(n: NFT, videoFormat: any, myBucket: any) {
  const scaledVideoKey = `videos/${n.contract}/scaledx750/${n.id}.${videoFormat}`;

  const exists = await objectExists(s3, myBucket, scaledVideoKey);
  if (!exists) {
    console.log(
      '[S3]',
      `[MISSING SCALED ${videoFormat}]`,
      `[CONTRACT ${n.contract}]`,
      `[ID ${n.id}]`
    );

    console.log('[S3]', `[SCALING ${scaledVideoKey}]`);

    await createTempFile(s3, myBucket, scaledVideoKey);

    console.log('[S3]', `[TEMP CREATED ${scaledVideoKey}]`);

    const videoURL = n.animation
      ? n.animation
      : n.metadata.animation
      ? n.metadata.animation
      : n.metadata.animation_url;

    const resizedVideoStream = await scaleVideo(
      videoURL,
      videoFormat.toLowerCase()
    );

    console.log('[S3]', `[ACQUIRED SCALED STREAM ${scaledVideoKey}]`);

    resizedVideoStream.on('error', async function (err: any) {
      await deleteTempFile(s3, myBucket, scaledVideoKey);
      console.log(
        '[S3]',
        `[resizedVideoStream]`,
        `[SCALING FAILED ${scaledVideoKey}]`,
        `[${err}]`
      );
    });

    const ffstream = new Stream.PassThrough();
    resizedVideoStream.pipe(ffstream, { end: true });

    await new Promise((resolve, reject) => {
      const buffers: any = [];
      ffstream.on('data', function (buf) {
        console.log(
          `[S3]`,
          `[${scaledVideoKey}]`,
          `[ADDING CHUNK LENGTH ${buf.length}]`
        );
        if (buf.length > 0) {
          buffers.push(buf);
        }
      });
      ffstream.on('error', async function (err) {
        await deleteTempFile(s3, myBucket, scaledVideoKey);
        console.log('[S3]', `[SCALING FAILED ${scaledVideoKey}]`, `[${err}]`);
      });
      ffstream.on('end', async function () {
        console.log('[S3]', `[SCALING FINISHED ${scaledVideoKey}]`);

        if (buffers.length > 0) {
          const outputBuffer = Buffer.concat(buffers);

          if (outputBuffer.length > 0) {
            const uploadedScaleddVideo = await s3.send(
              new PutObjectCommand({
                Bucket: myBucket,
                Key: scaledVideoKey,
                Body: outputBuffer,
                ContentType: `video/${videoFormat.toLowerCase()}`
              })
            );

            console.log(
              '[S3]',
              `[SCALED ${videoFormat} PERSISTED AT ${uploadedScaleddVideo.ETag}`
            );
          }
        }
        await deleteTempFile(s3, myBucket, scaledVideoKey);
      });
    });
  }
}

async function scaleVideo(url: string, format: string): Promise<any> {
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
    console.log('[S3]', `[SPECIAL CASE 30.MP4`);
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
  console.log(
    `[RESIZING FOR ${nft.contract} #${nft.id} (WEBP: ${toWEBP})]`,
    `[TO TARGET HEIGHT ${height}]`
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
    console.log(
      `[RESIZING FOR ${nft.contract} #${nft.id}]`,
      `[TO TARGET HEIGHT ${height}]`,
      `[FAILED!]`,
      `[${err}]`
    );
  }
}
