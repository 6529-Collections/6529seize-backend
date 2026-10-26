import type { Metadata } from 'sharp';
import { UnprocessableResizeInput } from '@/media/resize-input';

// Native Node 22/x64, 2 GiB Lambda measurements: interlaced RGBA peaked at
// 588 MiB (100 MP/8-bit) and 718 MiB (64 MP/16-bit) in the resize process.
// Admission, bounded output and a monitored disposable process work together.
export const PNG_PREVIEW_LIMITS = Object.freeze({
  sourceBytes: 256 * 1024 * 1024,
  pixels8: 100_000_000,
  pixels16: 64_000_000,
  inputSide: 100_000,
  outputSide: 4096,
  outputPixels: 2_000_000,
  outputBytes: 10 * 1024 * 1024
});

export interface PreviewTarget {
  readonly width: number | null;
  readonly height: number | null;
  readonly fit: 'cover' | 'inside' | 'outside';
}

/** Pure functions are also embedded in the isolated worker: one policy. */
export function pngInputFailure(
  metadata: Metadata,
  limits: typeof PNG_PREVIEW_LIMITS
): 'INVALID_IMAGE' | 'DECODED_IMAGE_TOO_LARGE' | null {
  const values = [metadata.width, metadata.height, metadata.channels];
  if (
    metadata.format !== 'png' ||
    values.some((value) => !Number.isSafeInteger(value) || value! < 1) ||
    metadata.channels! > 4
  )
    return 'INVALID_IMAGE';
  let cap = 0;
  if (metadata.depth === 'uchar') cap = limits.pixels8;
  else if (metadata.depth === 'ushort') cap = limits.pixels16;
  if (
    !cap ||
    metadata.width! > limits.inputSide ||
    metadata.height! > limits.inputSide ||
    metadata.width! * metadata.height! > cap
  )
    return 'DECODED_IMAGE_TOO_LARGE';
  return null;
}

export function assertPngPreviewInput(metadata: Metadata): void {
  const failure = pngInputFailure(metadata, PNG_PREVIEW_LIMITS);
  if (failure) throw new UnprocessableResizeInput(failure);
}

/** Preserve ordinary fit/rotation behavior; cap oversized results as a box. */
export function boundPngPreview(
  metadata: Metadata,
  target: PreviewTarget,
  limits: typeof PNG_PREVIEW_LIMITS
): PreviewTarget {
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = rotated ? metadata.height! : metadata.width!;
  const height = rotated ? metadata.width! : metadata.height!;
  const x = target.width ? target.width / width : null;
  const y = target.height ? target.height / height : null;
  let factor: number;
  if (x === null) factor = y!;
  else if (y === null) factor = x;
  else factor = target.fit === 'inside' ? Math.min(x, y) : Math.max(x, y);
  factor = Math.min(1, factor);
  let outputWidth = Math.max(1, Math.round(width * factor));
  let outputHeight = Math.max(1, Math.round(height * factor));
  if (target.fit === 'cover' && target.width && target.height) {
    outputWidth = Math.min(outputWidth, target.width);
    outputHeight = Math.min(outputHeight, target.height);
  }
  if (
    outputWidth <= limits.outputSide &&
    outputHeight <= limits.outputSide &&
    outputWidth * outputHeight <= limits.outputPixels
  )
    return { width: target.width, height: target.height, fit: target.fit };
  const shrink = Math.min(
    limits.outputSide / outputWidth,
    limits.outputSide / outputHeight,
    Math.sqrt(limits.outputPixels / (outputWidth * outputHeight))
  );
  return {
    width: Math.max(1, Math.floor(outputWidth * shrink)),
    height: Math.max(1, Math.floor(outputHeight * shrink)),
    fit: 'inside'
  };
}
