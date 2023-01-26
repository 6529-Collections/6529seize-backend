import { NFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NFT_ORIGINAL_IMAGE_LINK
} from './constants';
import AWS from 'aws-sdk';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { Stream } from 'stream';
import ffmpeg from 'fluent-ffmpeg';

const imagescript = require('imagescript');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;
const config = require('./config');

const s3 = new AWS.S3({
  accessKeyId: config.aws.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.aws.AWS_SECRET_ACCESS_KEY
});

export const persistS3 = async (nfts: NFT[]) => {
  console.log(
    new Date(),
    '[S3]',
    `[PROCESSING ASSETS FOR ${nfts.length} NFTS]`,
    `[ASYNC]`
  );

  const myBucket = config.aws.AWS_IMAGES_BUCKET_NAME;

  nfts.map(async (n) => {
    let format: any;

    if (areEqualAddresses(n.contract, MEMES_CONTRACT)) {
      format = n.metadata.image_details.format;
    }
    if (areEqualAddresses(n.contract, GRADIENT_CONTRACT)) {
      format = n.metadata.image.split('.').pop();
    }

    if (format) {
      const imageKey = `images/original/${n.contract}/${n.id}.${format}`;

      try {
        const a = await s3
          .headObject({ Bucket: myBucket, Key: imageKey })
          .promise();
      } catch (error: any) {
        if (error.code === 'NotFound') {
          console.log(
            new Date(),
            '[S3]',
            `[MISSING IMAGE]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            new Date(),
            '[S3]',
            `[FETCHING IMAGE]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const imageURL = n.metadata.image;
          const res = await fetch(imageURL);
          const blob = await res.arrayBuffer();
          console.log(
            new Date(),
            '[S3]',
            `[IMAGE DOWNLOADED]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const uploadedImage = await s3
            .upload({
              Bucket: myBucket,
              Key: imageKey,
              Body: Buffer.from(blob),
              ContentType: `image/${format.toLowerCase()}`
            })
            .promise();

          console.log(
            new Date(),
            '[S3]',
            `[IMAGE PERSISTED AT ${uploadedImage.Location}`
          );
        }
      }

      if (n.scaled) {
        let scaledFormat = 'WEBP';
        if (format.toUpperCase() == 'GIF') {
          scaledFormat = 'GIF';
        }
        const scaledKey = `images/scaled_x1000/${n.contract}/${n.id}.${scaledFormat}`;

        try {
          await s3.headObject({ Bucket: myBucket, Key: scaledKey }).promise();
        } catch (error: any) {
          if (error.code === 'NotFound') {
            console.log(
              new Date(),
              '[S3]',
              `[MISSING SCALED]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            console.log(
              new Date(),
              '[S3]',
              `[FETCHING IMAGE FOR SCALED]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const scaledURL = `${NFT_ORIGINAL_IMAGE_LINK}${n.contract}/${n.id}.${format}`;
            const res = await fetch(scaledURL);
            const blob = await res.arrayBuffer();
            console.log(
              new Date(),
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

            const uploadedScaledImage = await s3
              .upload({
                Bucket: myBucket,
                Key: scaledKey,
                Body: scaledBuffer,
                ContentType: `image/${scaledFormat}`
              })
              .promise();

            console.log(
              new Date(),
              '[S3]',
              `[SCALED PERSISTED AT ${uploadedScaledImage.Location}`
            );
          }
        }
      }

      if (n.thumbnail) {
        let thumbnailFormat = 'WEBP';
        if (format.toUpperCase() == 'GIF') {
          thumbnailFormat = 'GIF';
        }
        const thumbnailKey = `images/scaled_x450/${n.contract}/${n.id}.${thumbnailFormat}`;

        try {
          await s3
            .headObject({ Bucket: myBucket, Key: thumbnailKey })
            .promise();
        } catch (error: any) {
          if (error.code === 'NotFound') {
            console.log(
              new Date(),
              '[S3]',
              `[MISSING THUMBNAIL]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            console.log(
              new Date(),
              '[S3]',
              `[FETCHING IMAGE FOR THUMBNAIL]`,
              `[CONTRACT ${n.contract}]`,
              `[ID ${n.id}]`
            );

            const thumbnailURL = `${NFT_ORIGINAL_IMAGE_LINK}${n.contract}/${n.id}.${format}`;
            const res = await fetch(thumbnailURL);
            const blob = await res.arrayBuffer();
            console.log(
              new Date(),
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

            const uploadedThumbnail = await s3
              .upload({
                Bucket: myBucket,
                Key: thumbnailKey,
                Body: thumbBuffer,
                ContentType: `image/${thumbnailFormat}`
              })
              .promise();

            console.log(
              new Date(),
              '[S3]',
              `[THUMBNAIL PERSISTED AT ${uploadedThumbnail.Location}`
            );
          }
        }
      }
    }

    const animationDetails = n.metadata.animation_details;

    if (animationDetails && animationDetails.format?.toUpperCase() == 'MP4') {
      const videoFormat = animationDetails.format.toUpperCase();
      const videoKey = `videos/${n.contract}/${n.id}.${videoFormat}`;

      try {
        await s3.headObject({ Bucket: myBucket, Key: videoKey }).promise();
      } catch (error: any) {
        if (error.code === 'NotFound') {
          console.log(
            new Date(),
            '[S3]',
            `[MISSING ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            new Date(),
            '[S3]',
            `[FETCHING ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const videoURL = n.metadata.animation;
          const res = await fetch(videoURL);
          const blob = await res.arrayBuffer();
          console.log(
            new Date(),
            '[S3]',
            `[DOWNLOADED ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const uploadedVideo = await s3
            .upload({
              Bucket: myBucket,
              Key: videoKey,
              Body: Buffer.from(blob),
              ContentType: `video/mp4`
            })
            .promise();

          console.log(
            new Date(),
            '[S3]',
            `[${videoFormat} PERSISTED AT ${uploadedVideo.Location}`
          );
        }
      }

      const compressedVideoKey = `videos/${n.contract}/compressed/${n.id}.${videoFormat}`;

      try {
        await s3
          .headObject({ Bucket: myBucket, Key: compressedVideoKey })
          .promise();
      } catch (error: any) {
        if (error.code === 'NotFound') {
          console.log(
            new Date(),
            '[S3]',
            `[MISSING COMPRESSED ${videoFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            new Date(),
            '[S3]',
            `[COMPRESSING ${compressedVideoKey}]`
          );

          const videoURL = n.animation ? n.animation : n.metadata.animation;

          const resizedVideoStream = await resizeVideo(
            videoURL,
            videoFormat.toLowerCase()
          );
          resizedVideoStream.on('error', function (err) {
            console.log(
              new Date(),
              '[S3]',
              `[COMPRESSION FAILED ${compressedVideoKey}]`,
              `[${err}]`
            );
          });
          const writeStream = new Stream.PassThrough();
          const ffstream = resizedVideoStream.pipe(writeStream, {
            end: true
          });

          const buffers: any[] = [];
          ffstream.on('data', function (buf) {
            buffers.push(buf);
          });
          ffstream.on('error', function (err) {
            console.log(
              new Date(),
              '[S3]',
              `[COMPRESSION FAILED ${compressedVideoKey}]`,
              `[${err}]`
            );
          });
          ffstream.on('end', async function () {
            const outputBuffer = Buffer.concat(buffers);

            console.log(
              new Date(),
              '[S3]',
              `[COMPRESSION FINISHED ${compressedVideoKey}]`
            );

            const uploadedCompressedVideo = await s3
              .upload({
                Bucket: myBucket,
                Key: compressedVideoKey,
                Body: Buffer.from(outputBuffer),
                ContentType: `video/${videoFormat.toLowerCase()}`
              })
              .promise();

            console.log(
              new Date(),
              '[S3]',
              `[COMPRESSED ${videoFormat} PERSISTED AT ${uploadedCompressedVideo.Location}`
            );
          });
        }
      }
    }

    if (animationDetails && animationDetails.format == 'HTML') {
      const htmlFormat = animationDetails.format;
      const htmlKey = `html/${n.contract}/${n.id}.${htmlFormat}`;

      try {
        await s3.headObject({ Bucket: myBucket, Key: htmlKey }).promise();
      } catch (error: any) {
        if (error.code === 'NotFound') {
          console.log(
            new Date(),
            '[S3]',
            `[MISSING ${htmlFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          console.log(
            new Date(),
            '[S3]',
            `[FETCHING ${htmlFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const htmlUrl = n.metadata.animation;
          const res = await fetch(htmlUrl);
          const blob = await res.arrayBuffer();
          console.log(
            new Date(),
            '[S3]',
            `[DOWNLOADED ${htmlFormat}]`,
            `[CONTRACT ${n.contract}]`,
            `[ID ${n.id}]`
          );

          const uploadedHTML = await s3
            .upload({
              Bucket: myBucket,
              Key: htmlKey,
              Body: Buffer.from(blob),
              ContentType: `text/html; charset=utf-8;`
            })
            .promise();

          console.log(
            new Date(),
            '[S3]',
            `[${htmlFormat} PERSISTED AT ${uploadedHTML.Location}`
          );
        }
      }
    }
  });
};

async function resizeVideo(
  url: string,
  format: string
): Promise<ffmpeg.FfmpegCommand> {
  return ffmpeg({ source: url })
    .addOption('-crf 35')
    .videoCodec('libx264')
    .audioCodec('aac')
    .inputFormat(format)
    .outputFormat(format)
    .native()
    .outputOptions(['-movflags frag_keyframe+empty_moov']);
}

async function resizeImage(
  nft: NFT,
  toWEBP: boolean,
  buffer: Buffer,
  height: number
) {
  console.log(
    new Date(),
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
  } catch {
    console.log(
      new Date(),
      `[RESIZING FOR ${nft.contract} #${nft.id}]`,
      `[TO TARGET HEIGHT ${height}]`,
      `[FAILED!]`
    );
  }
}
