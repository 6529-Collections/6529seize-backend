import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DEVICE_POSTER_METADATA_KEY,
  DEVICE_POSTER_METADATA_VALUE,
  getDeviceVideoPosterKey,
  MAX_DEVICE_POSTER_BYTES
} from '../media/chat-video-poster';

/** Only API-validated images suppress frame capture; lookup failure keeps fallback. */
export async function hasDeviceVideoPoster(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<boolean> {
  // Legacy keys cannot receive API device posters; skip their guaranteed misses.
  const posterKey = getDeviceVideoPosterKey(key);
  if (!posterKey) return false;
  try {
    const image = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: posterKey }),
      { abortSignal: AbortSignal.timeout(3000) }
    );
    return (
      image.ContentType === 'image/jpeg' &&
      (image.ContentLength ?? 0) > 0 &&
      (image.ContentLength ?? 0) <= MAX_DEVICE_POSTER_BYTES &&
      image.Metadata?.[DEVICE_POSTER_METADATA_KEY] ===
        DEVICE_POSTER_METADATA_VALUE
    );
  } catch {
    return false;
  }
}
