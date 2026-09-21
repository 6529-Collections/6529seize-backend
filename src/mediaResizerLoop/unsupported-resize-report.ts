import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@/logging';

const logger = Logger.get('MEDIA_RESIZER_UNSUPPORTED_INPUT');

/** Claim one report across sizes and Lambda instances for this exact source revision. */
export async function reportUnsupportedResizeOnce(
  s3: S3Client,
  bucket: string | undefined,
  sourceKey: string,
  sourceRevision: string | undefined
): Promise<void> {
  try {
    if (!bucket || !sourceRevision) throw new Error('Missing source identity');
    const identity = createHash('sha256')
      .update(
        JSON.stringify([bucket, sourceKey, sourceRevision, 'UNSUPPORTED_CODEC'])
      )
      .digest('hex');
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: `_resize-rejections/v1/${identity}`,
      Body: '',
      ContentType: 'application/octet-stream',
      CacheControl: 'no-store',
      IfNoneMatch: '*'
    });
    if (!(await claimReport(s3, command))) return;
    const error = new Error(
      'Image resize rejected: unsupported HEIF compression'
    );
    error.name = 'MediaResize.UnsupportedCodec';
    // Source identity stays in private logs, not in the operational envelope.
    logger.error(
      `Unsupported image codec; source fingerprint ${identity}`,
      error
    );
  } catch (cause) {
    // Failure to deduplicate is operational, never a reason to silently suppress.
    const status = safeHttpStatus(cause);
    const error = new Error(
      `Unable to record unsupported image report [HTTP ${status ?? 'unknown'}]`
    );
    error.name = 'MediaResize.RejectionReportFailed';
    logger.error(error.message, error);
  }
}

async function claimReport(
  s3: S3Client,
  command: PutObjectCommand
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await s3.send(command);
      return true;
    } catch (error) {
      const status = safeHttpStatus(error);
      if (status === 412) return false;
      // A concurrent conditional write can conflict before a winner is visible.
      if (status !== 409 || attempt === 2) throw error;
    }
  }
}

/** Retain bounded status diagnostics, never SDK messages, request URLs or keys. */
function safeHttpStatus(error: unknown): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)
    ?.$metadata?.httpStatusCode;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}
