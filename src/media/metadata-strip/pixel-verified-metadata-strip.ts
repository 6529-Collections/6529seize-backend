import { createHash } from 'node:crypto';
import Sharp, { Metadata } from 'sharp';
import {
  describeImageContainer,
  extractJpegGainMaps,
  GainMapStripOutcome,
  logDroppedGainMap,
  LosslessStripFormat,
  LosslessStripResult,
  LosslessStripUnsupported,
  stripMetadataLosslessly
} from './lossless-metadata-strip';

/**
 * Raw pixels for the equality check stay in memory, one image at a time.
 * Matches the media workers' 512 MiB decoded-work budget, which allows four
 * working copies of the decoded image.
 */
export const PIXEL_CHECK_MAX_DECODED_BYTES = 128 * 1024 * 1024;
const PIXEL_CHECK_TIMEOUT_SECONDS = 30;
const INPUT_PIXEL_BACKSTOP = 1_000_000_000;

export type PixelVerifiedStripOutcome =
  | {
      readonly kind: 'lossless';
      readonly buffer: Buffer;
      readonly removed: readonly string[];
      /** Present only when the input carried a JPEG HDR gain map. */
      readonly gainMaps?: GainMapStripOutcome;
    }
  | { readonly kind: 'unverified'; readonly reason: string };

interface DecodedPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pages: number;
  readonly loop: number | null;
  readonly delay: string;
  readonly digest: string;
}

function decodedBytes(metadata: Metadata): number {
  const bytesPerSample = metadata.depth === 'ushort' ? 2 : 1;
  // With animated decoding, height already spans every frame.
  return (
    (metadata.width ?? 0) *
    (metadata.height ?? 0) *
    Math.max(4, metadata.channels ?? 4) *
    bytesPerSample
  );
}

function assertFitsPixelCheck(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > PIXEL_CHECK_MAX_DECODED_BYTES
  ) {
    throw new LosslessStripUnsupported(
      'Image is too large to compare decoded pixels in memory'
    );
  }
}

/** Oriented pixels exactly as clients see them; every frame when animated. */
async function decodePixels(
  input: Buffer,
  animated: boolean
): Promise<DecodedPixels> {
  const image = Sharp(input, {
    animated,
    failOn: 'none',
    limitInputPixels: INPUT_PIXEL_BACKSTOP
  }).timeout({ seconds: PIXEL_CHECK_TIMEOUT_SECONDS });
  const metadata = await image.metadata();
  assertFitsPixelCheck(decodedBytes(metadata));
  const { data, info } = await image
    .rotate()
    .raw(metadata.depth === 'ushort' ? { depth: 'ushort' } : {})
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    pages: metadata.pages ?? 1,
    loop: metadata.loop ?? null,
    delay: (metadata.delay ?? []).join(','),
    digest: createHash('sha256').update(data).digest('hex')
  };
}

function assertSamePixels(
  before: DecodedPixels,
  after: DecodedPixels,
  subject = ''
) {
  for (const field of Object.keys(before) as (keyof DecodedPixels)[]) {
    if (before[field] !== after[field]) {
      throw new LosslessStripUnsupported(
        `Decoded ${subject}${field} changed after stripping`
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Each kept gain map decodes to the same size and pixels as the original. */
async function assertSameGainMapPixels(input: Buffer, output: Buffer) {
  const before = extractJpegGainMaps(input);
  const after = extractJpegGainMaps(output);
  if (before.length !== after.length) {
    throw new LosslessStripUnsupported('Gain map count changed');
  }
  for (let index = 0; index < before.length; index++) {
    assertSamePixels(
      await decodePixels(before[index], false),
      await decodePixels(after[index], false),
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
  result: LosslessStripResult
): Promise<Pick<LosslessStripResult, 'output' | 'gainMaps'>> {
  if (result.gainMaps?.kind !== 'kept') return result;
  try {
    await assertSameGainMapPixels(input, result.output);
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
 * and by decoding input and output with sharp to the same oriented size,
 * animation and pixel hash; kept JPEG gain maps must decode to the same
 * pixels too, or they are dropped. Any failure of the image itself is
 * reported, not thrown, so callers can fall back to re-encoding.
 */
export async function stripMetadataWithPixelCheck(
  input: Buffer,
  format: LosslessStripFormat
): Promise<PixelVerifiedStripOutcome> {
  try {
    if (format === 'png') {
      // Bound the in-process decode from IHDR before any native PNG parser
      // runs, assuming the widest (16-bit RGBA) sample layout.
      const { width, height } = describeImageContainer(input, 'png');
      assertFitsPixelCheck(width * height * 8);
    }
    const result = stripMetadataLosslessly(input, format);
    const { output, gainMaps } = await withVerifiedGainMaps(
      input,
      format,
      result
    );
    const animated = format === 'gif' || format === 'webp';
    const before = await decodePixels(input, animated);
    const after = await decodePixels(output, animated);
    assertSamePixels(before, after);
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
