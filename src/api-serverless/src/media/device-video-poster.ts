import { decode, encode } from 'jpeg-js';
import { imageSize } from 'image-size';
import {
  ListPartsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  DEVICE_POSTER_METADATA_KEY,
  DEVICE_POSTER_METADATA_VALUE,
  getDeviceVideoPosterKey,
  MAX_DEVICE_POSTER_BASE64_LENGTH,
  MAX_DEVICE_POSTER_BYTES
} from '@/media/chat-video-poster';
import { Logger } from '@/logging';

const logger = Logger.get('DEVICE_VIDEO_POSTER');

/** Decode bounded JPEG pixels and re-encode, stripping client metadata. */
export function sanitizeDeviceVideoPoster(base64: string): Buffer {
  if (!base64 || base64.length > MAX_DEVICE_POSTER_BASE64_LENGTH) {
    throw new Error('Device poster exceeds the size limit');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length > MAX_DEVICE_POSTER_BYTES ||
    bytes.toString('base64') !== base64
  ) {
    throw new Error('Invalid device poster encoding');
  }
  // Dispatch only JPEG bytes to the size detector, never other image parsers.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error('Device poster must be a JPEG');
  }
  const dimensions = imageSize(bytes);
  if (
    dimensions.type !== 'jpg' ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > 640 ||
    dimensions.height > 640
  ) {
    throw new Error('Device poster must be a JPEG within 640 by 640 pixels');
  }
  // Canvas captures already contain oriented pixels. Preserve backend fallback
  // for other clients whose JPEG relies on metadata we would otherwise strip.
  if (dimensions.orientation !== undefined && dimensions.orientation !== 1) {
    throw new Error('Device poster requires EXIF orientation');
  }
  const image = decode(bytes, {
    tolerantDecoding: false,
    maxResolutionInMP: 0.41,
    maxMemoryUsageInMB: 16
  });
  if (image.width !== dimensions.width || image.height !== dimensions.height) {
    throw new Error('Inconsistent device poster dimensions');
  }
  const output = encode(
    { width: image.width, height: image.height, data: image.data },
    80
  ).data;
  if (output.length > MAX_DEVICE_POSTER_BYTES) {
    throw new Error('Sanitized device poster exceeds the size limit');
  }
  return output;
}

/** Called only after upload ownership is checked, before completing the video. */
export async function storeDeviceVideoPoster({
  s3,
  bucket,
  key,
  uploadId,
  base64
}: {
  s3: S3Client;
  bucket: string;
  key: string;
  uploadId: string;
  base64: string | undefined;
}): Promise<void> {
  const posterKey = getDeviceVideoPosterKey(key);
  // Only generated per-upload drop keys are eligible, never wave/distribution media.
  if (!base64 || !posterKey) {
    return;
  }
  let stage = 'validation';
  try {
    const bytes = sanitizeDeviceVideoPoster(base64);
    const abortSignal = AbortSignal.timeout(3000);
    stage = 'pending-upload';
    // A forged/stale upload ID must not let a client replace an existing poster.
    await s3.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      { abortSignal }
    );
    stage = 'storage';
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: posterKey,
        Body: bytes,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          [DEVICE_POSTER_METADATA_KEY]: DEVICE_POSTER_METADATA_VALUE
        }
      }),
      { abortSignal }
    );
  } catch {
    // Poster capture/validation/storage is best effort; the converter is the fallback.
    logger.warn('Device poster unavailable; using backend frame capture', {
      event: 'device_video_poster_fallback',
      stage
    });
  }
}
