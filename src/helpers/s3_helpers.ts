import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  txId
}: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  txId: string;
}) {
  const s3 = getS3();

  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: { [METADATA_KEY]: txId }
    })
  );

  return result;
}
