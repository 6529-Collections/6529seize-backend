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

function nextJpegSegment(bytes: Buffer, offset: number): number {
  if (offset + 2 > bytes.length) throw new Error('Truncated JPEG header');
  const length = bytes.readUInt16BE(offset);
  if (length < 2 || offset + length > bytes.length) {
    throw new Error('Invalid JPEG segment');
  }
  return offset + length;
}

/** APP1 can carry EXIF/XMP display transforms with conflicting interpretations. */
function assertNoApp1Metadata(bytes: Buffer): void {
  let offset = 2;
  while (offset < bytes.length) {
    offset = bytes.indexOf(0xff, offset);
    if (offset < 0) return;
    // Skip marker padding; FF00 is an escaped byte in scan data.
    while (bytes[offset] === 0xff) offset++;
    // A trailing run of FF bytes has no marker code and is malformed.
    const marker = bytes[offset++] ?? -1;
    if (marker === 0xe1) {
      throw new Error('Device poster contains APP1 metadata');
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      continue;
    }
    if (marker < 0xc0 || marker > 0xfe) {
      throw new Error('Invalid JPEG marker');
    }
    // Skip complete segments, including SOS headers, but continue across scans
    // so metadata after the first scan cannot bypass the policy either.
    offset = nextJpegSegment(bytes, offset);
  }
}

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
  if (
    bytes.length < 3 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    throw new Error('Device poster must be a JPEG');
  }
  // Device canvas exports have already-oriented pixels. Do not interpret or
  // discard client display transforms; let the converter generate the preview.
  assertNoApp1Metadata(bytes);
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
