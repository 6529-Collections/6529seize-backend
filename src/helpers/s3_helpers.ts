import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';
import { Logger } from '../logging';
import { getS3 } from '../s3.client';

const logger = Logger.get('S3_HELPERS');
const METADATA_KEY = 'tx-id';

export async function s3ObjectExists(
  myBucket: any,
  key: any,
  txId: string
): Promise<{
  exists: boolean;
  invalidate?: boolean;
}> {
  const s3 = getS3();
  const check = async (objectKey: string) => {
    try {
      const result = await s3.send(
        new HeadObjectCommand({ Bucket: myBucket, Key: objectKey })
      );

      const metadataTxId = result.Metadata?.[METADATA_KEY];
      if (!txId || metadataTxId === txId) {
        return { exists: true };
      }

      logger.info(
        `Mismatch ${METADATA_KEY} for ${objectKey}: expected ${txId}, found ${metadataTxId}`
      );
      return { exists: false, invalidate: true };
    } catch {
      return { exists: false };
    }
  };

  return await check(key);
}

export async function s3UploadObject({
  bucket,
  key,
  body,
  contentType,
  txId,
  contentLength
}: {
  bucket: string;
  key: string;
  body: Buffer | Readable;
  contentType: string;
  txId: string;
  contentLength?: number;
}) {
  const s3 = getS3();
  if (isReadableStream(body)) {
    const streamParams = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: { [METADATA_KEY]: txId },
      ...(typeof contentLength === 'number'
        ? { ContentLength: contentLength }
        : {})
    };

    const upload = new Upload({
      client: s3,
      params: streamParams
    });
    return await upload.done();
  }

  const bufferParams = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: { [METADATA_KEY]: txId },
    ...(typeof contentLength === 'number'
      ? { ContentLength: contentLength }
      : {})
  };

  const result = await s3.send(
    new PutObjectCommand({
      ...bufferParams
    })
  );

  return result;
}

function isReadableStream(body: Buffer | Readable): body is Readable {
  return !Buffer.isBuffer(body) && body instanceof Readable;
}
