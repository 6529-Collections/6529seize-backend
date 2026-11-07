import Sharp from 'sharp';
import { rgbaToThumbHash } from './thumbhash-encoder';

/**
 * Layout hints for an uploaded image (waves research R11-2): its displayed
 * size and a ThumbHash placeholder, so clients can reserve the right space
 * and paint a blurred preview before the image loads.
 */
export interface MediaLayoutHints {
  readonly width: number;
  readonly height: number;
  /** Base64 ThumbHash (about 25–35 characters). */
  readonly thumbhash: string;
}

/** ThumbHash encodes at most 100×100 pixels. */
const THUMBHASH_MAX_SIDE = 100;
const DESCRIBE_TIMEOUT_SECONDS = 15;

/**
 * Displayed size: EXIF orientations 5–8 rotate by 90°, swapping width and
 * height. Multi-frame images report one frame's height.
 */
export function orientedSize(metadata: {
  width?: number;
  height?: number;
  pageHeight?: number;
  pages?: number;
  orientation?: number;
}): { width: number; height: number } | null {
  const width = metadata.width;
  const height =
    (metadata.pages ?? 1) > 1 && metadata.pageHeight
      ? metadata.pageHeight
      : metadata.height;
  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }
  const swapped = (metadata.orientation ?? 1) >= 5;
  return swapped ? { width: height, height: width } : { width, height };
}

/**
 * Reads the published image's displayed size and encodes a ThumbHash from
 * its first frame, oriented as browsers show it.
 */
export async function describeImage(
  input: string | Buffer
): Promise<MediaLayoutHints | null> {
  const options = {
    animated: false,
    failOn: 'none' as const,
    limitInputPixels: 1_000_000_000
  };
  const metadata = await Sharp(input, options)
    .timeout({ seconds: DESCRIBE_TIMEOUT_SECONDS })
    .metadata();
  const size = orientedSize(metadata);
  if (!size) {
    return null;
  }
  const { data, info } = await Sharp(input, options)
    .timeout({ seconds: DESCRIBE_TIMEOUT_SECONDS })
    .rotate()
    .resize(THUMBHASH_MAX_SIDE, THUMBHASH_MAX_SIDE, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  return {
    ...size,
    thumbhash: Buffer.from(hash).toString('base64')
  };
}
