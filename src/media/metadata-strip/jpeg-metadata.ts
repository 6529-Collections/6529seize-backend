import {
  isOrientationOnlyTiff,
  minimalOrientationJpegExifPayload,
  readTiffOrientation
} from './exif-orientation';
import {
  analyzeGainMaps,
  gainMapImageSegments,
  GainMapAnalysis,
  gainMapMpfEntries,
  KeptGainMaps,
  KeptHdrSegments,
  primaryImageSegments,
  primaryImageSegmentsInPlace
} from './jpeg-gain-map';
import { buildMpfPayload, MPF_TIFF_OFFSET } from './jpeg-mpf';
import {
  APP0,
  APP1,
  APP2,
  frameSize,
  HdrSegmentKind,
  JpegLayout,
  JpegSegment,
  jpegSegment,
  segmentBytes,
  segmentRole,
  walkJpeg
} from './jpeg-structure';
import {
  ContainerDescription,
  FormatMetadataStripper,
  GainMapDescription,
  LosslessStripUnsupported,
  newRenderHash,
  StripOptions
} from './metadata-strip.types';

/** 'JFIF\0', version, units, X/Y density and the X/Y thumbnail size. */
const JFIF_HEADER_BYTES = 14;
/** Marker and length bytes before a segment payload. */
const SEGMENT_HEADER_BYTES = 4;

interface ImageDescription extends GainMapDescription {
  readonly orientation: number;
  readonly metadataBlocks: readonly string[];
}

interface StrippedImage {
  readonly bytes: Buffer;
  /** Offset of the kept MPF segment in `bytes`, if one was written. */
  readonly mpfAt: number | undefined;
}

function exifTiff(input: Buffer, segment: JpegSegment): Buffer {
  return input.subarray(segment.payloadStart + 6, segment.payloadEnd);
}

/** A short (malformed) JFIF header has no room for thumbnail pixels. */
function jfifHasThumbnail(input: Buffer, segment: JpegSegment): boolean {
  const length = segment.payloadEnd - segment.payloadStart;
  if (length < JFIF_HEADER_BYTES) return false;
  const thumbnailPixels =
    input[segment.payloadStart + 12] * input[segment.payloadStart + 13];
  return thumbnailPixels > 0 || length > JFIF_HEADER_BYTES;
}

function jfifWithoutThumbnail(input: Buffer, segment: JpegSegment): Buffer {
  if (!jfifHasThumbnail(input, segment)) return segmentBytes(input, segment);
  const output = Buffer.alloc(SEGMENT_HEADER_BYTES + JFIF_HEADER_BYTES);
  output[0] = 0xff;
  output[1] = APP0;
  output.writeUInt16BE(2 + JFIF_HEADER_BYTES, 2);
  input.copy(output, 4, segment.payloadStart, segment.payloadStart + 12);
  return output;
}

function orientationSegment(
  input: Buffer,
  segment: JpegSegment
): Buffer | null {
  const orientation = readTiffOrientation(exifTiff(input, segment));
  return orientation === 1
    ? null
    : jpegSegment(APP1, minimalOrientationJpegExifPayload(orientation));
}

/**
 * Writes one image (SOI to EOI): render segments verbatim, JFIF without its
 * thumbnail, the first EXIF reduced to Orientation, each HDR segment kind
 * replaced at its first position by the rebuilt segment in `kept` (or
 * dropped), and everything else dropped.
 */
function stripImage(
  image: Buffer,
  layout: JpegLayout,
  kept: KeptHdrSegments
): StrippedImage {
  const parts: Buffer[] = [image.subarray(0, 2)];
  let size = 2;
  let mpfAt: number | undefined;
  let exifSeen = false;
  const placed = new Set<HdrSegmentKind>();
  const push = (bytes: Buffer | null | undefined) => {
    if (!bytes) return;
    parts.push(bytes);
    size += bytes.length;
  };
  for (const segment of layout.segments) {
    const role = segmentRole(image, segment);
    if (role.kind === 'render') {
      push(segmentBytes(image, segment));
    } else if (role.kind === 'jfif') {
      push(jfifWithoutThumbnail(image, segment));
    } else if (role.kind === 'exif' && !exifSeen) {
      exifSeen = true;
      push(orientationSegment(image, segment));
    } else if (role.kind === 'hdr' && !placed.has(role.hdr)) {
      placed.add(role.hdr);
      if (role.hdr === 'mpf' && kept.mpf) mpfAt = size;
      push(kept[role.hdr]);
    }
  }
  return { bytes: Buffer.concat(parts), mpfAt };
}

/** Only the first segment of a kind can be kept, and only when it is exact. */
function isKeptHdrSegment(
  image: Buffer,
  segment: JpegSegment,
  expected: Buffer | undefined,
  first: boolean
): boolean {
  return (
    first &&
    expected !== undefined &&
    segmentBytes(image, segment).equals(expected)
  );
}

function describeImage(
  image: Buffer,
  layout: JpegLayout,
  kept: KeptHdrSegments,
  labelPrefix = ''
): ImageDescription {
  const metadataBlocks: string[] = [];
  const checked = new Set<HdrSegmentKind>();
  let orientation: number | undefined;
  const hash = newRenderHash();
  for (const segment of layout.segments) {
    const role = segmentRole(image, segment);
    if (role.kind === 'render') {
      hash.update(segmentBytes(image, segment));
    } else if (role.kind === 'jfif') {
      if (jfifHasThumbnail(image, segment)) {
        metadataBlocks.push(`${labelPrefix}APP0:JFIF-thumbnail`);
      }
    } else if (role.kind === 'exif') {
      const tiff = exifTiff(image, segment);
      orientation ??= readTiffOrientation(tiff);
      if (!isOrientationOnlyTiff(tiff)) {
        metadataBlocks.push(`${labelPrefix}APP1:Exif`);
      }
    } else if (
      role.kind === 'drop' ||
      !isKeptHdrSegment(image, segment, kept[role.hdr], !checked.has(role.hdr))
    ) {
      metadataBlocks.push(`${labelPrefix}${role.label}`);
    }
    if (role.kind === 'hdr') checked.add(role.hdr);
  }
  const size = frameSize(image, layout);
  if (!size) throw new LosslessStripUnsupported('JPEG has no frame header');
  return {
    ...size,
    orientation: orientation ?? 1,
    renderDigest: hash.digest('hex'),
    metadataBlocks
  };
}

/**
 * Strips each gain map, then the primary image with a placeholder MPF index
 * of the final length, then writes the real MPF offsets (relative to the MPF
 * TIFF header) once the primary image's size is known.
 */
function stripWithGainMaps(
  input: Buffer,
  layout: JpegLayout,
  kept: KeptGainMaps
): Buffer {
  const gainMaps = kept.gainMaps.map(
    (gainMap) =>
      stripImage(gainMap.image, gainMap.layout, gainMapImageSegments(gainMap))
        .bytes
  );
  const sizes = gainMaps.map((gainMap) => gainMap.length);
  const placeholder = gainMapMpfEntries(
    kept,
    0,
    sizes.map(() => 0),
    sizes
  );
  const primary = stripImage(
    input.subarray(0, layout.end),
    layout,
    primaryImageSegments(kept, sizes, placeholder)
  );
  if (primary.mpfAt !== undefined) {
    const tiffStart = primary.mpfAt + SEGMENT_HEADER_BYTES + MPF_TIFF_OFFSET;
    let cursor = primary.bytes.length;
    const offsets = sizes.map((size) => {
      const offset = cursor - tiffStart;
      cursor += size;
      return offset;
    });
    const entries = gainMapMpfEntries(
      kept,
      primary.bytes.length,
      offsets,
      sizes
    )!;
    jpegSegment(APP2, buildMpfPayload(entries)).copy(
      primary.bytes,
      primary.mpfAt
    );
  }
  return Buffer.concat([primary.bytes, ...gainMaps]);
}

function strip(input: Buffer, options?: StripOptions): Buffer {
  const layout = walkJpeg(input);
  const analysis =
    options?.gainMaps === 'drop' ? null : analyzeGainMaps(input, layout);
  return analysis?.kind === 'kept'
    ? stripWithGainMaps(input, layout, analysis)
    : stripImage(input, layout, {}).bytes;
}

/** Bytes after the primary image that are not a kept gain map, in order. */
function hasUncoveredTrailingData(
  input: Buffer,
  layout: JpegLayout,
  kept: KeptGainMaps | null
): boolean {
  let cursor = layout.end;
  for (const gainMap of kept?.gainMaps ?? []) {
    if (gainMap.start !== cursor) return true;
    cursor = gainMap.end;
  }
  return cursor !== input.length;
}

function describe(input: Buffer): ContainerDescription {
  const layout = walkJpeg(input);
  const analysis = analyzeGainMaps(input, layout);
  if (analysis.kind !== 'kept') {
    return describeLayout(input, layout, analysis, null);
  }
  try {
    return describeLayout(input, layout, analysis, analysis);
  } catch {
    // A gain map that cannot be described is dropped; the primary decides.
    return describeLayout(
      input,
      layout,
      { kind: 'unsupported', reason: 'Gain map could not be described' },
      null
    );
  }
}

function describeLayout(
  input: Buffer,
  layout: JpegLayout,
  analysis: GainMapAnalysis,
  kept: KeptGainMaps | null
): ContainerDescription {
  const primary = describeImage(
    input,
    layout,
    kept ? primaryImageSegmentsInPlace(kept, layout) : {}
  );
  const gainMaps = (kept?.gainMaps ?? []).map((gainMap) =>
    describeImage(
      gainMap.image,
      gainMap.layout,
      gainMapImageSegments(gainMap),
      'GainMap:'
    )
  );
  const metadataBlocks = primary.metadataBlocks.concat(
    ...gainMaps.map((gainMap) => gainMap.metadataBlocks)
  );
  if (hasUncoveredTrailingData(input, layout, kept)) {
    metadataBlocks.push('trailing-data');
  }
  return {
    width: primary.width,
    height: primary.height,
    orientation: primary.orientation,
    renderDigest: primary.renderDigest,
    metadataBlocks,
    gainMaps: gainMaps.map(({ width, height, renderDigest }) => ({
      width,
      height,
      renderDigest
    })),
    ...(analysis.kind === 'unsupported'
      ? { gainMapIssue: analysis.reason }
      : {})
  };
}

/** The gain map images (SOI to EOI) a strip of this JPEG keeps. */
export function jpegGainMapImages(input: Buffer): Buffer[] {
  const analysis = analyzeGainMaps(input, walkJpeg(input));
  return analysis.kind === 'kept'
    ? analysis.gainMaps.map((gainMap) => gainMap.image)
    : [];
}

export const jpegMetadataStripper: FormatMetadataStripper = {
  strip,
  describe
};
