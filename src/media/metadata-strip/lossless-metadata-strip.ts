import { Logger } from '@/logging';
import { gifMetadataStripper } from './gif-metadata';
import { jpegGainMapImages, jpegMetadataStripper } from './jpeg-metadata';
import {
  ContainerDescription,
  FormatMetadataStripper,
  LosslessStripUnsupported
} from './metadata-strip.types';
import { pngMetadataStripper } from './png-metadata';
import { webpMetadataStripper } from './webp-metadata';

export { LosslessStripUnsupported } from './metadata-strip.types';
export type {
  ContainerDescription,
  GainMapDescription
} from './metadata-strip.types';

export type LosslessStripFormat = 'jpeg' | 'png' | 'webp' | 'gif';

const logger = Logger.get('MEDIA_METADATA_STRIP');

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

const GAIN_MAP_FIELDS = ['width', 'height', 'renderDigest'] as const;

export interface LosslessStripOptions {
  /**
   * `keep` (the default) keeps verified JPEG HDR gain maps; `drop` removes
   * them as well, leaving the SDR base image.
   */
  readonly gainMaps?: 'keep' | 'drop';
}

/** What happened to a JPEG HDR gain map the input carried. */
export type GainMapStripOutcome =
  | { readonly kind: 'kept'; readonly count: number }
  | { readonly kind: 'dropped'; readonly reason: string };

export interface LosslessStripResult {
  readonly output: Buffer;
  /** The input's description; its `metadataBlocks` lists what was removed. */
  readonly input: ContainerDescription;
  /** Present only when the input carried a JPEG HDR gain map. */
  readonly gainMaps?: GainMapStripOutcome;
}

export function describeImageContainer(
  input: Buffer,
  format: LosslessStripFormat
): ContainerDescription {
  return STRIPPERS[format].describe(input);
}

/** The gain map images (SOI to EOI) a JPEG strip keeps; empty otherwise. */
export function extractJpegGainMaps(input: Buffer): Buffer[] {
  return jpegGainMapImages(input);
}

export function logDroppedGainMap(reason: string): void {
  logger.warn(
    `Dropped a JPEG HDR gain map and kept the SDR base image: ${reason}`
  );
}

function assertPreserved(
  before: ContainerDescription,
  after: ContainerDescription,
  gainMaps: boolean
): void {
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
  if (!gainMaps) return;
  const expected = before.gainMaps ?? [];
  const actual = after.gainMaps ?? [];
  if (expected.length !== actual.length) {
    throw new LosslessStripUnsupported('Stripping changed the gain maps');
  }
  expected.forEach((gainMap, index) => {
    for (const field of GAIN_MAP_FIELDS) {
      if (gainMap[field] !== actual[index][field]) {
        throw new LosslessStripUnsupported(
          `Stripping changed a gain map ${field}`
        );
      }
    }
  });
}

function verifiedStrip(
  stripper: FormatMetadataStripper,
  input: Buffer,
  before: ContainerDescription,
  gainMaps: 'keep' | 'drop'
): Buffer {
  const output = stripper.strip(input, { gainMaps });
  assertPreserved(before, stripper.describe(output), gainMaps === 'keep');
  return output;
}

function droppedOutcome(
  reason: string | undefined
): GainMapStripOutcome | undefined {
  return reason === undefined ? undefined : { kind: 'dropped', reason };
}

/**
 * Removes identifying metadata (EXIF beyond Orientation, XMP, IPTC/Photoshop,
 * comments, text chunks, timestamps, thumbnails and trailing data) without
 * touching image data, then re-parses the output to prove it: same size and
 * orientation, a byte-identical render stream (pixels, tables, ICC, animation)
 * and none of the removed blocks. Throws {@link LosslessStripUnsupported}.
 *
 * JPEG HDR gain maps (Ultra HDR, ISO 21496-1, Apple HDR) are kept with a
 * rebuilt MPF index, ISO 21496-1 blocks and an XMP packet reduced to gain map
 * values; each gain map is stripped the same way and must re-parse with a
 * byte-identical render stream. A gain map that is unrecognised,
 * inconsistent or does not verify is dropped with a warning, keeping the SDR
 * base image; it never makes the strip fail.
 */
export function stripMetadataLosslessly(
  input: Buffer,
  format: LosslessStripFormat,
  options: LosslessStripOptions = {}
): LosslessStripResult {
  const stripper = STRIPPERS[format];
  const before = stripper.describe(input);
  const hasGainMaps = Boolean(before.gainMaps?.length);
  if (options.gainMaps === 'drop') {
    return {
      output: verifiedStrip(stripper, input, before, 'drop'),
      input: before,
      gainMaps: droppedOutcome(
        hasGainMaps || before.gainMapIssue ? 'Not requested' : undefined
      )
    };
  }
  let dropReason = before.gainMapIssue;
  if (hasGainMaps) {
    try {
      return {
        output: verifiedStrip(stripper, input, before, 'keep'),
        input: before,
        gainMaps: { kind: 'kept', count: before.gainMaps!.length }
      };
    } catch (error) {
      // Whatever went wrong with the gain maps, the SDR strip below decides.
      dropReason = `Kept gain map did not verify: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  const output = verifiedStrip(stripper, input, before, 'drop');
  if (dropReason !== undefined) logDroppedGainMap(dropReason);
  return { output, input: before, gainMaps: droppedOutcome(dropReason) };
}
