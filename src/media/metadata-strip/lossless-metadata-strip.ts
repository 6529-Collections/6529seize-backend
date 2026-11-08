import { gifMetadataStripper } from './gif-metadata';
import { jpegMetadataStripper } from './jpeg-metadata';
import {
  ContainerDescription,
  FormatMetadataStripper,
  LosslessStripUnsupported
} from './metadata-strip.types';
import { pngMetadataStripper } from './png-metadata';
import { webpMetadataStripper } from './webp-metadata';

export { LosslessStripUnsupported } from './metadata-strip.types';
export type { ContainerDescription } from './metadata-strip.types';

export type LosslessStripFormat = 'jpeg' | 'png' | 'webp' | 'gif';

const STRIPPERS: Record<LosslessStripFormat, FormatMetadataStripper> = {
  jpeg: jpegMetadataStripper,
  png: pngMetadataStripper,
  webp: webpMetadataStripper,
  gif: gifMetadataStripper
};

const PRESERVED_FIELDS = [
  'width',
  'height',
  'orientation',
  'renderDigest'
] as const;

export interface LosslessStripResult {
  readonly output: Buffer;
  /** The input's description; its `metadataBlocks` lists what was removed. */
  readonly input: ContainerDescription;
}

export function describeImageContainer(
  input: Buffer,
  format: LosslessStripFormat
): ContainerDescription {
  return STRIPPERS[format].describe(input);
}

/**
 * Removes identifying metadata (EXIF beyond Orientation, XMP, IPTC/Photoshop,
 * comments, text chunks, timestamps, thumbnails and trailing data) without
 * touching image data, then re-parses the output to prove it: same size and
 * orientation, a byte-identical render stream (pixels, tables, ICC, animation)
 * and none of the removed blocks. Throws {@link LosslessStripUnsupported}.
 */
export function stripMetadataLosslessly(
  input: Buffer,
  format: LosslessStripFormat
): LosslessStripResult {
  const stripper = STRIPPERS[format];
  const before = stripper.describe(input);
  const output = stripper.strip(input);
  const after = stripper.describe(output);
  if (after.metadataBlocks.length) {
    throw new LosslessStripUnsupported(
      `Metadata remains after stripping: ${after.metadataBlocks.join(', ')}`
    );
  }
  for (const field of PRESERVED_FIELDS) {
    if (before[field] !== after[field]) {
      throw new LosslessStripUnsupported(`Stripping changed the ${field}`);
    }
  }
  return { output, input: before };
}
