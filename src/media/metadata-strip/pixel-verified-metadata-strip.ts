import {
  DecodedImage,
  DecodedPixelDigest,
  digestDecodedPixels,
  inspectDecodedImage,
  PIXEL_CHECK_LIMITS,
  PixelCheckBudget,
  PixelCheckLimits
} from './decoded-pixel-digest';
import {
  extractJpegGainMaps,
  GainMapStripOutcome,
  logDroppedGainMap,
  LosslessStripFormat,
  LosslessStripResult,
  LosslessStripUnsupported,
  stripMetadataLosslessly
} from './lossless-metadata-strip';

export { PIXEL_CHECK_LIMITS } from './decoded-pixel-digest';
export type { PixelCheckLimits } from './decoded-pixel-digest';

/**
 * Default source ceiling for the in-memory lossless strip: the upload limit.
 * The strip holds the source and its output (and, when a gain map does not
 * verify, one more output) next to one pixel band and the decoder's working
 * set; docs/image-upload-format-validation.md shows this fits the 2 GiB
 * sanitizer Lambda. Callers with a different memory budget pass their own.
 */
export const LOSSLESS_STRIP_MAX_SOURCE_BYTES = 256 * 1024 * 1024;

export interface PixelCheckOptions {
  /** Larger sources are reported unverified without being parsed. */
  readonly maxSourceBytes?: number;
  /** Overrides for {@link PIXEL_CHECK_LIMITS}. */
  readonly limits?: Partial<PixelCheckLimits>;
}

export type PixelVerifiedStripOutcome =
  | {
      readonly kind: 'lossless';
      readonly buffer: Buffer;
      readonly removed: readonly string[];
      /** Present only when the input carried a JPEG HDR gain map. */
      readonly gainMaps?: GainMapStripOutcome;
    }
  | { readonly kind: 'unverified'; readonly reason: string };

function assertSameFields<T extends DecodedImage | DecodedPixelDigest>(
  before: T,
  after: T,
  subject: string
): void {
  for (const field of Object.keys(before) as (keyof T & string)[]) {
    if (before[field] !== after[field]) {
      throw new LosslessStripUnsupported(
        `Decoded ${subject}${field} changed after stripping`
      );
    }
  }
}

/**
 * Same orientation, size, frames, timing and pixels. Equal orientation and
 * equal stored pixels mean equal oriented pixels, so stored pixels are
 * hashed: auto-rotating would make libvips hold the whole image in memory.
 */
async function assertSamePixels(
  input: Buffer,
  output: Buffer,
  format: LosslessStripFormat,
  budget: PixelCheckBudget,
  subject = ''
): Promise<void> {
  const before = await inspectDecodedImage(input, format, budget.limits);
  const after = await inspectDecodedImage(output, format, budget.limits);
  assertSameFields(before, after, subject);
  assertSameFields(
    await digestDecodedPixels(input, format, before, budget),
    await digestDecodedPixels(output, format, after, budget),
    subject
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each kept gain map decodes to the same size and pixels as the original. */
async function assertSameGainMapPixels(
  input: Buffer,
  output: Buffer,
  budget: PixelCheckBudget
) {
  const before = extractJpegGainMaps(input);
  const after = extractJpegGainMaps(output);
  if (before.length !== after.length) {
    throw new LosslessStripUnsupported('Gain map count changed');
  }
  for (let index = 0; index < before.length; index++) {
    await assertSamePixels(
      before[index],
      after[index],
      'jpeg',
      budget,
      'gain map '
    );
  }
}

/**
 * Keeps gain maps only when they decode to the original pixels; otherwise the
 * gain maps are dropped (with a warning) and the SDR base image is kept.
 */
async function withVerifiedGainMaps(
  input: Buffer,
  format: LosslessStripFormat,
  result: LosslessStripResult,
  budget: PixelCheckBudget
): Promise<Pick<LosslessStripResult, 'output' | 'gainMaps'>> {
  if (result.gainMaps?.kind !== 'kept') return result;
  try {
    await assertSameGainMapPixels(input, result.output, budget);
    return result;
  } catch (error) {
    const reason = `Gain map pixels did not verify: ${errorMessage(error)}`;
    const { output } = stripMetadataLosslessly(input, format, {
      gainMaps: 'drop'
    });
    logDroppedGainMap(reason);
    return { output, gainMaps: { kind: 'dropped', reason } };
  }
}

/**
 * Lossless strip, proven twice: structurally (see stripMetadataLosslessly)
 * and by decoding input and output with sharp to the same orientation, size,
 * animation and pixel hash; kept JPEG gain maps must decode to the same
 * pixels too, or they are dropped. Pixels are hashed band by band, so memory
 * stays bounded for any image within PIXEL_CHECK_LIMITS. Any failure of the
 * image itself, a limit included, is reported rather than thrown, so callers
 * can fall back to re-encoding or skip the file.
 */
export async function stripMetadataWithPixelCheck(
  input: Buffer,
  format: LosslessStripFormat,
  options: PixelCheckOptions = {}
): Promise<PixelVerifiedStripOutcome> {
  const limits = { ...PIXEL_CHECK_LIMITS, ...options.limits };
  const budget = { limits, deadline: Date.now() + limits.timeBudgetMs };
  try {
    const maxSourceBytes =
      options.maxSourceBytes ?? LOSSLESS_STRIP_MAX_SOURCE_BYTES;
    if (input.length > maxSourceBytes) {
      throw new LosslessStripUnsupported(
        'Source is larger than the lossless strip limit'
      );
    }
    const result = stripMetadataLosslessly(input, format);
    const { output, gainMaps } = await withVerifiedGainMaps(
      input,
      format,
      result,
      budget
    );
    await assertSamePixels(input, output, format, budget);
    return {
      kind: 'lossless',
      buffer: output,
      removed: result.input.metadataBlocks,
      ...(gainMaps ? { gainMaps } : {})
    };
  } catch (error) {
    return { kind: 'unverified', reason: errorMessage(error) };
  }
}
