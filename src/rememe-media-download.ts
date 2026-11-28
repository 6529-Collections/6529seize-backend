import sharp from 'sharp';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { publicFetch } from '@/http/public-fetch';
import { detectRasterImageFormat } from '@/media/raster-image-format';
import { detectStorableVideoContentType } from '@/media/video-container';

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_DEADLINE_MS = 5 * 60_000;
const FETCH_MAX_REDIRECTS = 5;
const MAX_REMEME_MEDIA_BYTES = 100 * 1024 * 1024;
const RASTER_IMAGE_FORMATS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);

export async function fetchRememeMedia(
  imageUrl: string,
  expectedFormat: string
): Promise<Buffer> {
  return withArweaveFallback(
    imageUrl,
    async (candidate, signal) => {
      const response = await publicFetch(candidate, {
        method: 'GET',
        signal,
        maxBytes: MAX_REMEME_MEDIA_BYTES,
        maxRedirects: FETCH_MAX_REDIRECTS,
        requestTimeoutMs: FETCH_TIMEOUT_MS,
        timeoutMs: FETCH_DEADLINE_MS
      });
      if (!response.ok)
        throw new Error(
          `Failed to fetch rememe ${expectedFormat} media: ${response.status}`
        );
      await validateMedia(response.body, expectedFormat);
      return response.body;
    },
    { timeoutMs: FETCH_DEADLINE_MS, attemptTimeoutMs: FETCH_TIMEOUT_MS }
  );
}

async function validateMedia(
  bytes: Buffer,
  expectedFormat: string
): Promise<void> {
  if (!RASTER_IMAGE_FORMATS.has(expectedFormat)) {
    if (!detectStorableVideoContentType(bytes)) {
      throw new Error('Rememe media is not a supported video');
    }
    return;
  }
  if (!(await detectRasterImageFormat(bytes))) {
    throw new Error('Rememe media is not a supported image');
  }
  // Decode the first frame: header inspection alone accepts truncated images.
  // Later animation frames retain the existing derivative-processing failure path.
  await sharp(bytes)
    .resize({ width: 1, height: 1, fit: 'inside' })
    .raw()
    .toBuffer();
}
