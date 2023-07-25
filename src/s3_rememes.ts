import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { RequestInfo, RequestInit } from 'node-fetch';
import { Rememe } from './entities/IRememe';
import { getContentType, parseIpfsUrlToCloudflare } from './helpers';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

const imagescript = require('imagescript');

const ICON_HEIGHT = 60;
const THUMBNAIL_HEIGHT = 450;
const SCALED_HEIGHT = 1000;

let s3: S3Client;
let myBucket: string;

export const persistRememesS3 = async (rememes: Rememe[]) => {
  s3 = new S3Client({ region: 'eu-west-1' });

  console.log(
    '[S3 REMEMES]',
    `[PROCESSING ASSETS FOR ${rememes.length} REMEMES]`
  );

  myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

  for (const r of rememes) {
    let image = r.media && r.media.gateway ? r.media.gateway : r.image;
    if (image) {
      const format = await getContentType(image);

      if (format) {
        const originalKey = `rememes/images/original/${r.contract}-${r.id}.${format}`;
        const scaledKey = `rememes/images/scaled/${r.contract}-${r.id}.${format}`;
        const thumbnailKey = `rememes/images/thumbnail/${r.contract}-${r.id}.${format}`;
        const iconKey = `rememes/images/icon/${r.contract}-${r.id}.${format}`;

        const exists = await objectExists(myBucket, originalKey);

        if (!exists) {
          console.log(
            '[S3 REMEMES]',
            `[MISSING IMAGE]`,
            `[CONTRACT ${r.contract}]`,
            `[ID ${r.id}]`
          );

          const res = await fetch(parseIpfsUrlToCloudflare(image));
          const blob = await res.arrayBuffer();

          await handleImageUpload(originalKey, format, blob);

          let scaledFormat = 'webp';
          if (format.toLowerCase() == 'gif') {
            scaledFormat = 'gif';
          }

          const scaledBuffer = await resizeImage(
            r,
            scaledFormat == 'webp' ? true : false,
            Buffer.from(blob),
            SCALED_HEIGHT
          );

          await handleImageUpload(scaledKey, format, scaledBuffer);

          const thumbnailBuffer = await resizeImage(
            r,
            scaledFormat == 'webp' ? true : false,
            Buffer.from(blob),
            THUMBNAIL_HEIGHT
          );

          await handleImageUpload(thumbnailKey, format, thumbnailBuffer);

          const iconBuffer = await resizeImage(
            r,
            scaledFormat == 'webp' ? true : false,
            Buffer.from(blob),
            ICON_HEIGHT
          );

          await handleImageUpload(iconKey, format, iconBuffer);
        }
      }
    }
  }
};

async function handleImageUpload(
  key: string,
  format: string,
  blob: ArrayBuffer
) {
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: key,
      Body: Buffer.from(blob),
      ContentType: `image/${format}`
    })
  );

  console.log(
    '[S3 REMEMES]',
    `[UPLOADED ${key}]`,
    `[STATUS ${put.$metadata.httpStatusCode}]`
  );
}

async function objectExists(myBucket: any, key: any): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: myBucket, Key: key }));
    console.log('objectExists', key);
    return true;
  } catch (error1: any) {
    try {
      await s3.send(
        new HeadObjectCommand({ Bucket: myBucket, Key: `${key}__temp` })
      );
      console.log('objectExists', `${key}__temp`);
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
) {
  console.log(
    `[RESIZING FOR ${rememe.contract} #${rememe.id} (WEBP: ${toWEBP})]`,
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
      `[RESIZING FOR ${rememe.contract} #${rememe.id}]`,
      `[TO TARGET HEIGHT ${height}]`,
      `[FAILED!]`,
      `[${err}]`
    );
  }
}
