import { join, dirname } from 'node:path';
import Sharp, { Metadata } from 'sharp';
import { Logger } from '@/logging';
import { inspectResizeInput } from '@/mediaResizerLoop/resize-resource-safety';
import { preparePngPreview } from '@/media/png-preview';

export const STANDARD_PREVIEW_HEIGHTS = [450, 1080] as const;

/**
 * Native time for each non-PNG preview. Admission (`inspectResizeInput`)
 * already bounds decoded memory; this bounds only CPU time. Both previews
 * together (240 s), the pixel check's own 240 s budget and the S3 transfers
 * stay well inside the sanitizer Lambda's 900 s timeout, so a slow admitted
 * upload holds one of its two reserved slots for a few minutes at most.
 * The previous 30 s was too little for large animated GIFs.
 */
export const PREVIEW_TIMEOUT_SECONDS = 120;

/**
 * Previews only: effort 1 is libimagequant's fastest palette search, which
 * mediaResizerLoop's GIF previews already use. Resizing a dithered GIF blends
 * its pixels into thousands of new colours, and Sharp's default (effort 7)
 * then spends about half a second re-quantising each 400 x 450 frame: over a
 * minute for 128 frames. Originals are never re-encoded here.
 */
export const GIF_PREVIEW_ENCODER = { effort: 1 } as const;

export const PREVIEW_TIMEOUT_MESSAGE =
  'This image took too long to process. Reduce its dimensions or animation frame count and upload again.';

const logger = Logger.get('UPLOAD_IMAGE_PREVIEWS');

/**
 * A native preview timeout. Its message is shown to the uploader if retries
 * run out; it stays an operational (retryable) failure, not an input rejection.
 */
export class UploadPreviewTimeoutError extends Error {
  constructor(readonly nativeMessage: string) {
    super(PREVIEW_TIMEOUT_MESSAGE);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'UploadPreviewTimeoutError';
  }
}

export interface UploadImagePreview {
  readonly path: string;
  readonly option: string;
  readonly contentType: string;
}

/** Metadata only, never pixels, so a slow preview can be sized from its logs. */
function describePreview(
  metadata: Metadata,
  animated: boolean,
  height: number
): string {
  const frameHeight = metadata.pageHeight ?? metadata.height;
  const progressive = metadata.isProgressive ? ' progressive' : '';
  const pages = metadata.pages ?? 1;
  let frames = '';
  if (pages > 1)
    frames = animated ? `, ${pages} frames` : `, first of ${pages} frames`;
  return `AUTOx${height} preview of${progressive} ${metadata.format} ${metadata.width} x ${frameHeight}${frames}`;
}

async function writeSharpPreview(
  source: string,
  path: string,
  height: number,
  metadata: Metadata,
  animated: boolean
): Promise<void> {
  const format = metadata.format!;
  const started = Date.now();
  try {
    await Sharp(source, {
      failOn: 'error',
      animated,
      limitInputPixels: 1_000_000_000
    })
      .timeout({ seconds: PREVIEW_TIMEOUT_SECONDS })
      .resize(null, height, {
        withoutEnlargement: true,
        fit: 'cover',
        fastShrinkOnLoad: true
      })
      .rotate()
      .toFormat(format, format === 'gif' ? GIF_PREVIEW_ENCODER : undefined)
      .toFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^timeout: \d+% complete/.test(message)) throw error;
    logger.warn(
      `${describePreview(metadata, animated, height)} timed out after ${Date.now() - started} ms: ${message.split('\n')[0]}`
    );
    throw new UploadPreviewTimeoutError(message);
  }
  logger.info(
    `${describePreview(metadata, animated, height)} took ${Date.now() - started} ms`
  );
}

/** Generate both before publishing anything. The caller owns the directory. */
export async function prepareUploadImagePreviews(
  source: string,
  contentType: string
): Promise<UploadImagePreview[]> {
  const previews: UploadImagePreview[] = [];
  const smallestPreviewHeight = Math.min(...STANDARD_PREVIEW_HEIGHTS);
  for (const height of STANDARD_PREVIEW_HEIGHTS) {
    const target = { width: null, height, fit: 'cover' as const };
    const { metadata, resizeAnimated } = await inspectResizeInput(
      source,
      contentType === 'image/gif',
      target
    );
    const frameHeight = metadata.pageHeight ?? metadata.height;
    const firstPreview = previews[0];
    // Both targets leave small GIFs at their original size. Reuse the first
    // preview only after its strict decode/re-encode has succeeded.
    if (
      metadata.format === 'gif' &&
      resizeAnimated &&
      frameHeight !== undefined &&
      frameHeight <= smallestPreviewHeight &&
      firstPreview
    ) {
      previews.push({
        path: firstPreview.path,
        option: `AUTOx${height}`,
        contentType
      });
      continue;
    }
    let path: string;
    if (metadata.format === 'png') {
      path = await preparePngPreview(source, target);
    } else {
      path = join(dirname(source), `preview-${height}.${metadata.format}`);
      await writeSharpPreview(source, path, height, metadata, resizeAnimated);
    }
    previews.push({ path, option: `AUTOx${height}`, contentType });
  }
  return previews;
}

/** Insert next to the filename, including root-level object keys. */
export function previewObjectKey(key: string, option: string): string {
  const slash = key.lastIndexOf('/');
  return `${key.slice(0, slash + 1)}${option}/${key.slice(slash + 1)}`;
}
