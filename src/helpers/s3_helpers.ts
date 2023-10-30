import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';

export async function objectExists(
  s3: S3Client,
  myBucket: any,
  key: any
): Promise<boolean> {
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
  return false;
}

export async function createTempFile(s3: S3Client, myBucket: any, key: any) {
  await s3.send(
    new PutObjectCommand({
      Bucket: myBucket,
      Key: `${key}__temp`,
      Body: Buffer.from('temp')
    })
  );
}

export async function deleteTempFile(s3: S3Client, myBucket: any, key: any) {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: myBucket,
      Key: `${key}__temp`
    })
  );
}
