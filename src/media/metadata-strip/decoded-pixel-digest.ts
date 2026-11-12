import { createHash } from 'node:crypto';
import Sharp, { Metadata, SharpOptions } from 'sharp';
import { PNG_PREVIEW_LIMITS } from '@/media/png-preview-policy';
import { walkJpeg } from './jpeg-structure';
import type { LosslessStripFormat } from './lossless-metadata-strip';
import { LosslessStripUnsupported } from './metadata-strip.types';
import { releaseBuffer } from './release-buffer';

// libvips's operation cache would keep each band's decoder alive, together
// with untracked decoder state such as a progressive JPEG's coefficients,
// so bands would accumulate. The media workers already run without it.
Sharp.cache(false);

/**
 * Explicit bounds for decoding an image during the pixel check. They replace
 * a decoded-size cap: pixels are hashed in bands, so memory no longer grows
 * with the image, only with the band and the decoder's own working set.
 */
export interface PixelCheckLimits {
  /**
   * Decompression-bomb ceiling: decoded pixels in every frame together,
   * enforced by sharp's `limitInputPixels` before any pixel is decoded.
   */
  readonly maxPixels: number;
  /**
   * Pixels in one frame for decoders that hold a whole frame in memory
   * (multi-scan JPEG, WebP, GIF), which bounds their working set. PNG uses
   * the upload pipeline's PNG limits instead, checked from IHDR before any
   * native parser runs.
   */
  readonly maxWholeFramePixels: number;
  /** Raw pixel bytes held in Node at once (one band). */
  readonly bandBytes: number;
  /** Wall-clock budget for one verification: input, output and gain maps. */
  readonly timeBudgetMs: number;
}

/**
 * Sized for the 2 GiB `dropMediaSanitizer` Lambda; see
 * docs/image-upload-format-validation.md for the memory and time arithmetic.
 */
export const PIXEL_CHECK_LIMITS: PixelCheckLimits = Object.freeze({
  // 16,384 x 16,384, the largest WebP and four times the AVIF cap.
  maxPixels: 268_435_456,
  // The AVIF and 16-bit PNG caps: at most about 512 MiB of decoder state.
  maxWholeFramePixels: 64_000_000,
  bandBytes: 64 * 1024 * 1024,
  timeBudgetMs: 240_000
});

/** What the decoder reports before any pixel is decoded. */
export interface DecodedImage {
  /** EXIF orientation as sharp applies it; 1 when absent. */
  readonly orientation: number;
  /** Stored (not oriented) frame size. */
  readonly width: number;
  readonly height: number;
  readonly pages: number;
  readonly channels: number;
  readonly depth: 'uchar' | 'ushort';
  readonly loop: number | null;
  readonly delay: string;
}

export interface DecodedPixelDigest {
  /** Channels in the raw output that was hashed. */
  readonly channels: number;
  /** SHA-256 of every frame's raw pixels, frame by frame, row by row. */
  readonly digest: string;
}

export interface PixelCheckBudget {
  readonly limits: PixelCheckLimits;
  /** Epoch milliseconds after which decoding stops. */
  readonly deadline: number;
}

interface Band {
  readonly page: number;
  readonly pages: number;
  readonly top: number;
  readonly rows: number;
}

const isAnimatedFormat = (format: LosslessStripFormat) =>
  format === 'gif' || format === 'webp';

function decoderOptions(
  format: LosslessStripFormat,
  limits: PixelCheckLimits,
  pages: Pick<SharpOptions, 'page' | 'pages'>
): SharpOptions {
  return {
    failOn: 'none',
    sequentialRead: true,
    limitInputPixels: limits.maxPixels,
    ...(isAnimatedFormat(format) ? pages : {})
  };
}

/** The upload pipeline's PNG limits: 100 MP at 8 bits, 64 MP at 16 bits. */
function pngWithinLimits(
  width: number,
  height: number,
  sixteenBit: boolean
): boolean {
  const cap = sixteenBit
    ? PNG_PREVIEW_LIMITS.pixels16
    : PNG_PREVIEW_LIMITS.pixels8;
  return (
    width <= PNG_PREVIEW_LIMITS.inputSide &&
    height <= PNG_PREVIEW_LIMITS.inputSide &&
    width * height <= cap
  );
}

/**
 * The upload pipeline's PNG limits (100 MP at 8 bits, 64 MP at 16 bits,
 * 100,000 pixels a side), read from IHDR before any native PNG parser runs.
 */
export function assertPngWithinPixelCheck(input: Buffer): void {
  if (input.length < 33 || input.toString('latin1', 12, 16) !== 'IHDR') {
    throw new LosslessStripUnsupported('PNG does not start with IHDR');
  }
  const width = input.readUInt32BE(16);
  const height = input.readUInt32BE(20);
  if (!pngWithinLimits(width, height, input[24] === 16)) {
    throw new LosslessStripUnsupported(
      'PNG is too large to decode for the pixel check'
    );
  }
}

/** Sharp metadata of one page or of every page; see canVerifyDecodedPixels. */
export type PixelCheckMetadata = Partial<
  Pick<
    Metadata,
    'format' | 'width' | 'height' | 'pageHeight' | 'pages' | 'depth'
  > & { isProgressive: boolean }
>;

const isPositiveInteger = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! >= 1;

/**
 * Admission from metadata, before any pixel is decoded: whether an image is
 * within the pixel check's bounds (every GIF or WebP page counted). A strip
 * must still pass the check itself, which also holds a non-interleaved
 * baseline JPEG (indistinguishable here) to the whole-frame cap. Without a
 * format or a progressive flag the stricter rules apply.
 */
export function canVerifyDecodedPixels(
  metadata: PixelCheckMetadata,
  limits: PixelCheckLimits = PIXEL_CHECK_LIMITS
): boolean {
  const { format, width } = metadata;
  // A single-page load reports one frame's height; an animated load adds
  // pageHeight and reports every frame in height.
  const height = metadata.pageHeight ?? metadata.height;
  const pages =
    format === 'gif' || format === 'webp' ? (metadata.pages ?? 1) : 1;
  if (
    !isPositiveInteger(width) ||
    !isPositiveInteger(height) ||
    !isPositiveInteger(pages) ||
    width * height * pages > limits.maxPixels
  ) {
    return false;
  }
  if (format === 'png') {
    return pngWithinLimits(width, height, metadata.depth === 'ushort');
  }
  const wholeFrame = format !== 'jpeg' || metadata.isProgressive !== false;
  return !wholeFrame || width * height <= limits.maxWholeFramePixels;
}

/** Progressive and non-interleaved JPEGs buffer every coefficient. */
function holdsWholeFrame(input: Buffer, format: LosslessStripFormat): boolean {
  if (format !== 'jpeg') return format !== 'png';
  return walkJpeg(input).segments.filter((s) => s.marker === 0xda).length > 1;
}

function positiveInteger(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value! < 1) {
    throw new LosslessStripUnsupported('Decoder reported an invalid size');
  }
  return value!;
}

/** Reads the decoder's view of the image and applies the limits. */
export async function inspectDecodedImage(
  input: Buffer,
  format: LosslessStripFormat,
  limits: PixelCheckLimits
): Promise<DecodedImage> {
  if (format === 'png') assertPngWithinPixelCheck(input);
  const metadata = await Sharp(
    input,
    decoderOptions(format, limits, { pages: -1 })
  ).metadata();
  const pages = positiveInteger(metadata.pages ?? 1);
  const width = positiveInteger(metadata.width);
  // With every page loaded, metadata.height spans all frames.
  const height = positiveInteger(
    isAnimatedFormat(format)
      ? (metadata.pageHeight ?? metadata.height! / pages)
      : metadata.height
  );
  if (
    holdsWholeFrame(input, format) &&
    width * height > limits.maxWholeFramePixels
  ) {
    throw new LosslessStripUnsupported(
      'Image frame is too large to decode for the pixel check'
    );
  }
  return {
    orientation: metadata.orientation ?? 1,
    width,
    height,
    pages,
    channels: positiveInteger(metadata.channels),
    depth: metadata.depth === 'ushort' ? 'ushort' : 'uchar',
    loop: metadata.loop ?? null,
    delay: (metadata.delay ?? []).join(',')
  };
}

const sampleBytes = (image: DecodedImage) => (image.depth === 'ushort' ? 2 : 1);

/**
 * Whole frames per band while a frame fits, otherwise row ranges of one
 * frame. Bands are contiguous, so the hash is that of the full raw image.
 */
function planBands(image: DecodedImage, bandBytes: number): Band[] {
  // Raw output never has more channels than the decoder (CMYK becomes RGB).
  const rowBytes =
    image.width * Math.max(4, image.channels) * sampleBytes(image);
  const frameBytes = rowBytes * image.height;
  const bands: Band[] = [];
  if (frameBytes <= bandBytes) {
    const perBand = Math.floor(bandBytes / frameBytes);
    for (let page = 0; page < image.pages; page += perBand) {
      const pages = Math.min(perBand, image.pages - page);
      bands.push({ page, pages, top: 0, rows: image.height });
    }
    return bands;
  }
  const rowsPerBand = Math.max(1, Math.floor(bandBytes / rowBytes));
  for (let page = 0; page < image.pages; page++) {
    for (let top = 0; top < image.height; top += rowsPerBand) {
      const rows = Math.min(rowsPerBand, image.height - top);
      bands.push({ page, pages: 1, top, rows });
    }
  }
  return bands;
}

/** sharp's timeout, in whole seconds, never past the deadline. */
function remainingSeconds(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new LosslessStripUnsupported('Pixel check ran out of time');
  }
  return Math.min(3600, Math.ceil(remaining / 1000));
}

/**
 * Hashes the decoded, unoriented pixels of every frame band by band, so
 * memory is bounded by one band plus libvips's working set whatever the
 * image size. Orientation is compared separately (see DecodedImage).
 */
export async function digestDecodedPixels(
  input: Buffer,
  format: LosslessStripFormat,
  image: DecodedImage,
  budget: PixelCheckBudget
): Promise<DecodedPixelDigest> {
  const hash = createHash('sha256');
  let channels: number | undefined;
  for (const band of planBands(image, budget.limits.bandBytes)) {
    let pipeline = Sharp(
      input,
      decoderOptions(format, budget.limits, {
        page: band.page,
        pages: band.pages
      })
    ).timeout({ seconds: remainingSeconds(budget.deadline) });
    if (band.rows !== image.height) {
      pipeline = pipeline.extract({
        left: 0,
        top: band.top,
        width: image.width,
        height: band.rows
      });
    }
    const { data, info } = await pipeline
      .raw(image.depth === 'ushort' ? { depth: 'ushort' } : {})
      .toBuffer({ resolveWithObject: true });
    channels ??= info.channels;
    const bytes =
      image.width * band.rows * band.pages * channels * sampleBytes(image);
    const expected = info.channels === channels && data.length === bytes;
    if (expected) hash.update(data);
    // Free each band now: waiting for garbage collection lets them pile up.
    releaseBuffer(data);
    if (!expected) {
      throw new LosslessStripUnsupported('Decoder returned an unexpected band');
    }
  }
  return { channels: channels!, digest: hash.digest('hex') };
}
