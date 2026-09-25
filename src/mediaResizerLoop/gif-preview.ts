import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import Sharp, { Metadata } from 'sharp';
import {
  assertDecodedWorkBudget,
  UnprocessableResizeInput
} from '@/mediaResizerLoop/resize-resource-safety';

// Decode one coalesced source frame at a time. Bound both retained output and
// repeated decoder work (seeking a GIF page can scan all preceding frames).
const MAX_FRAME_PIXELS = 8 * 1024 * 1024;
const MAX_OUTPUT_PIXELS = 8 * 1024 * 1024;
const MAX_FRAMES = 120;
const MAX_SCAN_PIXELS = 2_000_000_000;
const MAX_PASSTHROUGH_BYTES = 8 * 1024 * 1024;
const MAX_SECONDS = 20;

export interface GifPreviewTarget {
  width: number | null;
  height: number | null;
  fit: 'cover' | 'inside' | 'outside';
}

function rejectLarge(): never {
  throw new UnprocessableResizeInput('DECODED_IMAGE_TOO_LARGE');
}

function inspectGif(metadata: Metadata) {
  const width = metadata.width ?? 0;
  const height = metadata.pageHeight ?? metadata.height ?? 0;
  const pages = metadata.pages ?? 1;
  if (
    metadata.format !== 'gif' ||
    [width, height, pages].some(
      (value) => !Number.isSafeInteger(value) || value < 1
    )
  ) {
    throw new UnprocessableResizeInput('INVALID_IMAGE');
  }
  if (width * height > MAX_FRAME_PIXELS || pages > MAX_FRAMES) rejectLarge();
  return { width, height, pages };
}

function remainingSeconds(deadline: number) {
  const seconds = Math.floor((deadline - Date.now()) / 1000);
  if (seconds < 1) rejectLarge();
  return seconds;
}

function canKeepOriginal(
  metadata: Metadata,
  target: GifPreviewTarget,
  sourceBytes: number
) {
  const { width, height } = inspectGif(metadata);
  // Only AUTO dimensions are a provable no-op; fixed boxes may crop.
  const unchanged =
    (target.width === null &&
      target.height !== null &&
      height <= target.height) ||
    (target.height === null && target.width !== null && width <= target.width);
  if (!unchanged || sourceBytes > MAX_PASSTHROUGH_BYTES) return false;
  try {
    assertDecodedWorkBudget(metadata, true);
    return true;
  } catch (error) {
    if (!(error instanceof UnprocessableResizeInput)) throw error;
    return false;
  }
}

/** Bound the complete RGBA strip, including extreme one-pixel aspect ratios. */
export function getGifPreviewDimensions(
  width: number,
  height: number,
  pages: number
) {
  const ratio = Math.min(
    1,
    Math.sqrt(MAX_OUTPUT_PIXELS / (width * height * pages))
  );
  let outputWidth = Math.max(1, Math.floor(width * ratio));
  let outputHeight = Math.max(1, Math.floor(height * ratio));
  if (outputWidth * outputHeight * pages > MAX_OUTPUT_PIXELS) {
    if (outputWidth > outputHeight) {
      outputWidth = Math.floor(MAX_OUTPUT_PIXELS / (outputHeight * pages));
    } else {
      outputHeight = Math.floor(MAX_OUTPUT_PIXELS / (outputWidth * pages));
    }
  }
  return { width: outputWidth, height: outputHeight };
}

/** Only call within withResizeSourceFile: all output shares its cleanup scope. */
export async function prepareGifPreview(
  inputPath: string,
  target: GifPreviewTarget
) {
  const deadline = Date.now() + MAX_SECONDS * 1000;
  const metadata = await Sharp(inputPath, {
    limitInputPixels: MAX_FRAME_PIXELS
  }).metadata();
  const { width, height, pages } = inspectGif(metadata);
  if (canKeepOriginal(metadata, target, (await stat(inputPath)).size))
    return inputPath;
  if (width * height * ((pages * (pages + 1)) / 2) > MAX_SCAN_PIXELS)
    rejectLarge();

  const rawPath = `${inputPath}.rgba`;
  const outputPath = `${inputPath}.gif`;
  await writeFile(rawPath, Buffer.alloc(0));
  let outputWidth = 0;
  let outputHeight = 0;
  for (let page = 0; page < pages; page++) {
    const frame = await Sharp(inputPath, {
      page,
      pages: 1,
      limitInputPixels: MAX_FRAME_PIXELS
    })
      .resize(target.width, target.height, {
        fit: target.fit,
        withoutEnlargement: true
      })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .timeout({ seconds: remainingSeconds(deadline) })
      .toBuffer({ resolveWithObject: true });
    if (page === 0) {
      ({ width: outputWidth, height: outputHeight } = getGifPreviewDimensions(
        frame.info.width,
        frame.info.height,
        pages
      ));
    }
    const pixels =
      frame.info.width === outputWidth && frame.info.height === outputHeight
        ? frame.data
        : await Sharp(frame.data, { raw: frame.info })
            .resize(outputWidth, outputHeight, { fit: 'fill' })
            .raw()
            .timeout({ seconds: remainingSeconds(deadline) })
            .toBuffer();
    await appendFile(rawPath, pixels);
  }
  // Raw input is bounded to 32 MiB before Sharp reads it into memory.
  await Sharp(await readFile(rawPath), {
    raw: {
      width: outputWidth,
      height: outputHeight * pages,
      channels: 4,
      pageHeight: outputHeight
    }
  })
    .gif({
      delay: metadata.delay,
      loop: metadata.loop ?? 1,
      effort: 1,
      keepDuplicateFrames: true
    })
    .timeout({ seconds: remainingSeconds(deadline) })
    .toFile(outputPath);
  return outputPath;
}
