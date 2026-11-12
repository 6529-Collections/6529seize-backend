import sharp from 'sharp';

export type RasterImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

const RASTER_IMAGE_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'png',
  'gif',
  'webp'
]);

/**
 * Identifies the bytes as a JPEG, PNG, GIF or WebP image by decoding its
 * header with sharp. Returns null for anything else, including bytes that
 * only claim to be an image.
 */
export async function detectRasterImageFormat(
  bytes: Buffer
): Promise<RasterImageFormat | null> {
  try {
    const metadata = await sharp(bytes, { animated: true }).metadata();
    if (!metadata.width || !metadata.height) return null;
    return metadata.format && RASTER_IMAGE_FORMATS.has(metadata.format)
      ? (metadata.format as RasterImageFormat)
      : null;
  } catch {
    return null;
  }
}
