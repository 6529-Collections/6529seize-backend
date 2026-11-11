import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** What S3 says about an object: its stored size, or that it does not exist. */
export type ObjectSizeRead =
  | { readonly exists: true; readonly bytes: number }
  | { readonly exists: false };

const READ_TIMEOUT_MS = 5000;

function isMissingObject(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    $metadata?.httpStatusCode === 404
  );
}

/**
 * Reads an object's stored size with a HEAD. Only a 404 means the object
 * does not exist. Anything else that is not a size (403, which S3 also uses
 * for a missing key when the caller may not list the bucket, throttling,
 * network errors, a response without a length) is inconclusive and thrown.
 */
export async function readObjectSize(
  s3: Pick<S3Client, 'send'>,
  bucket: string,
  key: string
): Promise<ObjectSizeRead> {
  let length: number | undefined;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) }
    );
    length = head.ContentLength;
  } catch (error) {
    if (isMissingObject(error)) return { exists: false };
    throw error;
  }
  if (typeof length !== 'number') {
    throw new Error(`S3 reported no size for ${key}`);
  }
  return { exists: true, bytes: length };
}
