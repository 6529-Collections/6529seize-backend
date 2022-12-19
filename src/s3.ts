import { NFT } from './entities/INFT';
import { areEqualAddresses } from './helpers';
import {
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NFT_ORIGINAL_IMAGE_LINK
} from './constants';
import AWS from 'aws-sdk';
import fetch from 'node-fetch';
import jimp from 'jimp';

const MAX_HEIGHT = 450;
const config = require('./config');

const s3 = new AWS.S3({
  accessKeyId: config.aws.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.aws.AWS_SECRET_ACCESS_KEY
});

export const persistS3 = (nfts: NFT[]) => {
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
        await s3.headObject({ Bucket: myBucket, Key: imageKey }).promise();
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

      if (n.thumbnail && n.thumbnail.includes('scaled')) {
        const thumbnailKey = `images/scaled_x450/${n.contract}/${n.id}.${format}`;

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

            const thumbnail = await resize(
              Buffer.from(blob),
              n.metadata.image_details
            );

            const thumbBuffer = await thumbnail.getBufferAsync(
              thumbnail.getMIME()
            );

            const uploadedThumbnail = await s3
              .upload({
                Bucket: myBucket,
                Key: thumbnailKey,
                Body: thumbBuffer,
                ContentType: `image/${format.toLowerCase()}`
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

async function resize(buffer: Buffer, image_details: any) {
  const image = await jimp.read(buffer);
  const resized = image.resize(jimp.AUTO, MAX_HEIGHT);
  return resized;
}
