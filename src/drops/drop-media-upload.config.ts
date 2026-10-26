import { MAX_SOURCE_BYTES } from '@/media/resize-input';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { IMMUTABLE_MEDIA_CACHE_CONTROL } from '@/media/media-cache-control';

export const DROP_MEDIA_SANITIZER_QUEUE_NAME = 'drop-media-sanitizer';
export const DROP_MEDIA_INGEST_DEFAULT_REGION = 'eu-west-1';
export const DROP_MEDIA_INGEST_BUCKET_PREFIX = '6529-drop-media-ingest';
export const DROP_MEDIA_SANITIZED_METADATA_KEY = 'privacy-sanitized';
export const DROP_MEDIA_SANITIZED_METADATA_VALUE = 'true';
export const DROP_MEDIA_FORMAT_VALIDATED_METADATA_KEY = 'format-validated';
export const DROP_MEDIA_SANITIZE_UPLOAD_METADATA_KEY =
  'sanitize-image-metadata';
export const DROP_MEDIA_MAX_IMAGE_BYTES = MAX_SOURCE_BYTES;
export const DROP_MEDIA_CACHE_CONTROL = IMMUTABLE_MEDIA_CACHE_CONTROL;

let ingestS3: S3Client | undefined;

export function isDropMediaSanitizationEnabled(): boolean {
  return process.env.DROP_MEDIA_SANITIZE_IMAGES === 'true';
}

export function isImageMimeType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}

/** Map the declared upload type to the format served after sanitization. */
export function getPublishedDropMediaMimeType(contentType: string): string {
  if (contentType === 'image/avif') {
    return 'image/webp';
  }
  return contentType === 'image/jpg' ? 'image/jpeg' : contentType;
}

export function getDropMediaIngestS3Bucket(): string {
  const configuredBucket = process.env.DROP_MEDIA_INGEST_S3_BUCKET;
  if (configuredBucket) {
    return configuredBucket;
  }
  return `${DROP_MEDIA_INGEST_BUCKET_PREFIX}-${getAwsAccountId()}`;
}

export function getDropMediaIngestS3Region(): string {
  return (
    process.env.DROP_MEDIA_INGEST_S3_REGION ?? DROP_MEDIA_INGEST_DEFAULT_REGION
  );
}

export function getDropMediaIngestStagePrefix(): string {
  return process.env.DROP_MEDIA_INGEST_STAGE ?? getDefaultStagePrefix();
}

export function createDropMediaIngestKey({
  source,
  publicKey
}: {
  source: 'drop' | 'wave';
  publicKey: string;
}): string {
  return `${getDropMediaIngestStagePrefix()}/${source}-media-ingest/${publicKey}`;
}

export function getDropMediaIngestS3(): S3Client {
  if (!ingestS3) {
    ingestS3 = new S3Client({
      region: getDropMediaIngestS3Region(),
      requestHandler: new NodeHttpHandler({
        socketTimeout: 300_000
      })
    });
  }
  return ingestS3;
}

function getAwsAccountId(): string {
  const accountId = process.env.AWS_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('AWS_ACCOUNT_ID is not configured');
  }
  return accountId;
}

function getDefaultStagePrefix(): string {
  if (process.env.NODE_ENV === 'production') {
    return 'prod';
  }
  if (process.env.NODE_ENV === 'development') {
    return 'staging';
  }
  return 'local';
}
