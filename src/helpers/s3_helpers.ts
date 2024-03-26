import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { Logger } from '../logging';
import { getS3 } from '../s3.client';

const logger = Logger.get('S3_HELPERS');

export async function s3ObjectExists(
  myBucket: any,
  key: any
): Promise<boolean> {
  const s3 = getS3();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: myBucket, Key: key }));
    return true;
  } catch (error1: any) {
    try {
      await s3.send(
        new HeadObjectCommand({ Bucket: myBucket, Key: `${key}__temp` })
      );
      logger.info(`objectExists ${key}__temp`);
      return true;
    } catch (error2: any) {
      return false;
    }
  }
}

export async function s3CreateTempFile(myBucket: any, key: any) {
  await getS3().send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: `${key}__temp`,
      Body: Buffer.from('temp')
    })
  );
}

export async function s3DeleteTempFile(myBucket: any, key: any) {
  await getS3().send(
    new DeleteObjectCommand({
      Bucket: myBucket,
      Key: `${key}__temp`
    })
  );
}
