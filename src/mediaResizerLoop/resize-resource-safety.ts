import { Readable } from 'node:stream';
import {
  UnprocessableResizeInput,
  withResizeSourceFile
} from '@/media/resize-input';
import { assertPngPreviewInput } from '@/media/png-preview-policy';
export {
  MAX_SOURCE_BYTES,
  UnprocessableResizeInput,
  withResizeSourceFile
} from '@/media/resize-input';
import Sharp, { Metadata } from 'sharp';

// This Lambda handles one resize per invocation; retaining decoded operations or
// open temporary files between requests consumes its fixed resource budget.
Sharp.cache(false);

// Retain the original 1028 MiB function's conservative budgets even when its
// memory/CPU allocation is raised. Reserve space for codecs and multipart upload.
export const MAX_DECODED_WORK_BYTES = 512 * 1024 * 1024;
export const INPUT_PIXEL_BACKSTOP = 1_000_000_000;

interface ResizeTarget {
  readonly width: number | null;
  readonly height: number | null;
}

function jpegDecodeShrink(metadata: Metadata, target?: ResizeTarget): number {
  // Progressive JPEGs retain full-resolution coefficients even when shrinking.
  // Other codecs keep the existing full decoded-input estimate.
  if (
    metadata.format !== 'jpeg' ||
    metadata.isProgressive !== false ||
    metadata.depth !== 'uchar' ||
    !target
  )
    return 1;

  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = rotated ? metadata.height! : metadata.width!;
  const height = rotated ? metadata.width! : metadata.height!;
  const ratios = [];
  if (target.width) ratios.push(width / target.width);
  if (target.height) ratios.push(height / target.height);
  const shrink = Math.min(...ratios);
  if (!Number.isFinite(shrink)) return 1;

  // Sharp's fastShrinkOnLoad halves the JPEG factor at rounding boundaries.
  // cover/outside use the smaller axis; inside uses the larger one. Taking the
  // smaller ratio therefore never assumes more decoder shrink than either fit.
  if (shrink >= 9) return 8;
  if (shrink >= 5) return 4;
  if (shrink >= 3) return 2;
  return 1;
}

/** Only this known native decoder capability failure is a permanent rejection. */
export function classifyResizeDecoderError(error: unknown): unknown {
  if (
    error instanceof Error &&
    /(?:^|\n)heif: Error while loading plugin: Support for this compression format has not been built in \(11\.6003\)(?:\r?\n|$)/.test(
      error.message
    )
  ) {
    return new UnprocessableResizeInput('UNSUPPORTED_CODEC');
  }
  return error;
}

/** Conservative admission estimate, not a guarantee about native codec memory. */
export function assertDecodedWorkBudget(
  metadata: Metadata,
  animated: boolean,
  target?: ResizeTarget
) {
  if (metadata.format === 'png') {
    assertPngPreviewInput(metadata);
    return;
  }
  const pages = animated ? (metadata.pages ?? 1) : 1;
  // If per-frame height is absent, the reported height is a conservative bound;
  // still multiply by every page rather than risk admitting uncounted frames.
  const height =
    animated && pages > 1
      ? (metadata.pageHeight ?? metadata.height)
      : metadata.height;
  const sampleBytes: Record<string, number> = {
    char: 1,
    uchar: 1,
    short: 2,
    ushort: 2,
    int: 4,
    uint: 4,
    float: 4,
    double: 8,
    complex: 8,
    dpcomplex: 16
  };
  const values = [metadata.width, height, pages, metadata.channels];
  const bytesPerSample = sampleBytes[metadata.depth];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value! < 1) ||
    !bytesPerSample
  ) {
    throw new UnprocessableResizeInput('INVALID_IMAGE');
  }
  // Include every GIF frame, conversion to at least RGBA and four working copies.
  const shrink = jpegDecodeShrink(metadata, target);
  const estimatedBytes =
    Math.ceil(metadata.width! / shrink) *
    Math.ceil(height! / shrink) *
    pages *
    Math.max(4, metadata.channels!) *
    bytesPerSample *
    4;
  if (
    !Number.isSafeInteger(estimatedBytes) ||
    estimatedBytes > MAX_DECODED_WORK_BYTES
  )
    throw new UnprocessableResizeInput('DECODED_IMAGE_TOO_LARGE');
}

export function isUnprocessableResizeInput(error: unknown): boolean {
  // Native decoder messages are version-specific. Unmatched failures deliberately
  // propagate as operational errors rather than being cached as invalid input.
  return (
    error instanceof UnprocessableResizeInput ||
    (error instanceof Error &&
      /Input (?:file contains unsupported image format|file has corrupt header|image exceeds pixel limit)|VipsJpeg:|jpegload:|pngload:|gifload:|webpload:|tiffload:|heifload:/i.test(
        error.message
      ))
  );
}

/** Sharp retains and concatenates stream input; a file avoids those full copies. */
export async function withResizeInputFile<T>(
  source: Readable,
  contentLength: number | undefined,
  animated: boolean,
  useFile: (path: string, animated: boolean, metadata: Metadata) => Promise<T>,
  target?: ResizeTarget
): Promise<T> {
  return withResizeSourceFile(source, contentLength, async (path) => {
    const { metadata, resizeAnimated } = await inspectResizeInput(
      path,
      animated,
      target
    );
    return useFile(path, resizeAnimated, metadata);
  });
}

export async function inspectResizeInput(
  path: string,
  animated: boolean,
  target?: ResizeTarget
) {
  const metadata = await Sharp(path, {
    failOn: 'none',
    animated,
    limitInputPixels: INPUT_PIXEL_BACKSTOP
  })
    .metadata()
    .catch((error: unknown) => {
      throw classifyResizeDecoderError(error);
    });
  let resizeAnimated = animated;
  try {
    assertDecodedWorkBudget(metadata, animated, target);
  } catch (error) {
    if (
      !animated ||
      metadata.format !== 'gif' ||
      !(error instanceof UnprocessableResizeInput) ||
      error.code !== 'DECODED_IMAGE_TOO_LARGE'
    )
      throw error;

    // A still preview preserves access to the artwork without admitting the
    // entire animation. Even the first frame must fit the original budget.
    const firstFrame = await Sharp(path, {
      failOn: 'none',
      limitInputPixels: INPUT_PIXEL_BACKSTOP
    }).metadata();
    assertDecodedWorkBudget(firstFrame, false);
    resizeAnimated = false;
  }
  return { metadata, resizeAnimated };
}
