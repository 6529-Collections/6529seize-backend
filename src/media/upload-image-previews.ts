import { join, dirname } from 'node:path';
import Sharp from 'sharp';
import { inspectResizeInput } from '@/mediaResizerLoop/resize-resource-safety';
import { preparePngPreview } from '@/media/png-preview';

export const STANDARD_PREVIEW_HEIGHTS = [450, 1080] as const;

export interface UploadImagePreview {
  readonly path: string;
  readonly option: string;
  readonly contentType: string;
}

/** Generate both before publishing anything. The caller owns the directory. */
export async function prepareUploadImagePreviews(
  source: string,
  contentType: string
): Promise<UploadImagePreview[]> {
  const previews: UploadImagePreview[] = [];
  for (const height of STANDARD_PREVIEW_HEIGHTS) {
    const target = { width: null, height, fit: 'cover' as const };
    const { metadata, resizeAnimated } = await inspectResizeInput(
      source,
      contentType === 'image/gif',
      target
    );
    let path: string;
    if (metadata.format === 'png') {
      path = await preparePngPreview(source, target);
    } else {
      path = join(dirname(source), `preview-${height}.${metadata.format}`);
      await Sharp(source, {
        failOn: 'error',
        animated: resizeAnimated,
        limitInputPixels: 1_000_000_000
      })
        .timeout({ seconds: 30 })
        .resize(null, height, {
          withoutEnlargement: true,
          fit: 'cover',
          fastShrinkOnLoad: true
        })
        .rotate()
        .toFormat(metadata.format!)
        .toFile(path);
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
