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
  txId: string,
  options: { requireNonEmpty?: boolean } = {}
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

      // A previous successful HTTP response can still have uploaded no bytes.
      // Existence alone must not prevent a later retry/audit from repairing it.
      if (options.requireNonEmpty && result.ContentLength === 0) {
        logger.warn(`[EMPTY S3 OBJECT] [KEY ${objectKey}] [action=replace]`);
        return { exists: false, invalidate: true };
      }

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
  contentLength,
  cacheControl
}: {
  bucket: string;
  key: string;
  body: Buffer | Readable;
  contentType: string;
  txId: string;
  contentLength?: number;
  /** Stored on the object and served by S3/CloudFront as `Cache-Control`. */
  cacheControl?: string;
}) {
  const s3 = getS3();
  const cacheControlParams = cacheControl ? { CacheControl: cacheControl } : {};
  if (isReadableStream(body)) {
    const streamParams = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...cacheControlParams,
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
    ...cacheControlParams,
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
