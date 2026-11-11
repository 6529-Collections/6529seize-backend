import { createHash } from 'node:crypto';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Logger } from '@/logging';
import { HEIC_DECODER_POLICY } from '@/mediaResizerLoop/heic-preview';
import { UnprocessableResizeInput } from '@/mediaResizerLoop/resize-resource-safety';
import { claimReport } from '@/mediaResizerLoop/unsupported-resize-report';

const logger = Logger.get('MEDIA_RESIZER_HEIC_INPUT');

export async function withHeicResizeRejection<T>(
  s3: S3Client,
  bucket: string | undefined,
  sourceKey: string,
  revision: string | undefined,
  convert: () => Promise<T>
): Promise<T> {
  if (await hasHeicResizeRejection(s3, bucket, sourceKey, revision)) {
    throw new UnprocessableResizeInput('HEIC_DECODE_FAILED');
  }
  try {
    return await convert();
  } catch (error) {
    if (
      error instanceof UnprocessableResizeInput &&
      error.code === 'HEIC_DECODE_FAILED'
    ) {
      await reportHeicResizeRejectionOnce(s3, bucket, sourceKey, revision);
    }
    throw error;
  }
}

function rejectionKey(
  bucket: string | undefined,
  key: string,
  revision?: string
) {
  if (!bucket || !revision) throw new Error('Missing HEIC source identity');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([bucket, key, revision, HEIC_DECODER_POLICY]))
    .digest('hex');
  return `_resize-rejections/v2/${fingerprint}`;
}

/** Checked only for detected HEVC, before pixel decoding and across all sizes. */
export async function hasHeicResizeRejection(
  s3: S3Client,
  bucket: string | undefined,
  sourceKey: string,
  revision?: string
): Promise<boolean> {
  const key = rejectionKey(bucket, sourceKey, revision);
  try {
    const result = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    if (result.Metadata?.['rejection-code'] !== 'HEIC_DECODE_FAILED') {
      throw new Error('Invalid HEIC resize rejection marker');
    }
    return true;
  } catch (error) {
    const s3Error = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    if (
      s3Error.name === 'NotFound' &&
      s3Error.$metadata?.httpStatusCode === 404
    )
      return false;
    throw error;
  }
}

/** Cache only an explicit decoder rejection; failed marker storage must surface. */
export async function reportHeicResizeRejectionOnce(
  s3: S3Client,
  bucket: string | undefined,
  sourceKey: string,
  revision?: string
): Promise<void> {
  const key = rejectionKey(bucket, sourceKey, revision);
  if (
    !(await claimReport(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: '',
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
        Metadata: { 'rejection-code': 'HEIC_DECODE_FAILED' },
        IfNoneMatch: '*'
      })
    ))
  )
    return;
  const error = new Error('HEIC source rejected by the HEVC decoder');
  error.name = 'MediaResize.HeicDecodeRejected';
  logger.error(
    `HEIC resize rejected; source fingerprint ${key.split('/')[2]}`,
    error
  );
}
