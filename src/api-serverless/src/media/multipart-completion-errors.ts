import { BadRequestException } from '@/exceptions';

/**
 * S3 CompleteMultipartUpload errors caused by the request itself: an upload
 * that no longer exists (already completed or aborted) and parts that do not
 * match it. They answer 400, not 500.
 */
const CLIENT_MULTIPART_COMPLETION_ERRORS = new Set([
  'NoSuchUpload',
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall'
]);

function s3ErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { name, Code } = error as { name?: unknown; Code?: unknown };
  if (typeof name === 'string' && name) return name;
  return typeof Code === 'string' ? Code : '';
}

/**
 * The 400 for an S3 multipart completion error the client caused, or null
 * for any other error (which keeps its existing handling).
 */
export function multipartCompletionClientError(
  error: unknown
): BadRequestException | null {
  if (!CLIENT_MULTIPART_COMPLETION_ERRORS.has(s3ErrorCode(error))) return null;
  return new BadRequestException(
    error instanceof Error ? error.message : 'Invalid multipart upload'
  );
}
