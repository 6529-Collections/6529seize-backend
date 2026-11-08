import { createHash } from 'node:crypto';
import Sharp, { Metadata } from 'sharp';
import {
  describeImageContainer,
  LosslessStripFormat,
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

function assertSamePixels(before: DecodedPixels, after: DecodedPixels) {
  for (const field of Object.keys(before) as (keyof DecodedPixels)[]) {
    if (before[field] !== after[field]) {
      throw new LosslessStripUnsupported(
        `Decoded ${field} changed after stripping`
      );
    }
  }
}

/**
 * Lossless strip, proven twice: structurally (see stripMetadataLosslessly)
 * and by decoding input and output with sharp to the same oriented size,
 * animation and pixel hash. Any failure is reported, not thrown, so callers
 * can fall back to re-encoding.
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
    const { output, input: description } = stripMetadataLosslessly(
      input,
      format
    );
    const animated = format === 'gif' || format === 'webp';
    const before = await decodePixels(input, animated);
    const after = await decodePixels(output, animated);
    assertSamePixels(before, after);
    return {
      kind: 'lossless',
      buffer: output,
      removed: description.metadataBlocks
    };
  } catch (error) {
    return {
      kind: 'unverified',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
