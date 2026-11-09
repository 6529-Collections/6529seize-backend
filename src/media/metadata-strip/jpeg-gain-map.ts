import {
  APPLE_HDR_GAIN_MAP_NS,
  ContainerItem,
  GainMapXmp,
  hasGainMapProperty,
  hasHdrgmGainMapMetadata,
  HDRGM_NS,
  isAppleGainMapXmp,
  OutputDirectoryItem,
  parseGainMapXmp,
  serializeGainMapXmp
} from './gain-map-xmp';
import {
  buildMpfPayload,
  GainMapStructureError,
  isUndefinedJpegMpfType,
  MPF_TIFF_OFFSET,
  MpfEntry,
  parseMpfEntries,
  withoutDependencyFlags
} from './jpeg-mpf';
import {
  APP1,
  APP2,
  firstHdrSegments,
  frameSize,
  ISO_GAIN_MAP_SIGNATURE,
  JpegLayout,
  JpegSegment,
  jpegSegment,
  payloadAfter,
  SOI,
  walkJpeg,
  XMP_SIGNATURE
} from './jpeg-structure';

/**
 * Finds the HDR gain map images of an Ultra HDR (Adobe/Google gain map v1,
 * ISO 21496-1) or Apple HDR JPEG and decides whether they can be kept.
 *
 * Secondary images are located through the primary image's MPF index and/or
 * its Google container directory; when both are present they must agree. An
 * image is a gain map when its own metadata says so: `hdrgm` gain map values,
 * Apple's `urn:com:apple:photo:2020:aux:hdrgainmap` auxiliary type, or full
 * ISO 21496-1 metadata. Everything else after the primary image (MPF
 * thumbnails and previews, depth and matte images, motion photo video,
 * trailers) is dropped. Any inconsistency drops the gain maps instead, which
 * leaves the SDR base image; it never makes the strip fail.
 */

export interface GainMapImage {
  /** Absolute offsets of the image (SOI to EOI) in the file. */
  readonly start: number;
  readonly end: number;
  readonly image: Buffer;
  readonly layout: JpegLayout;
  /** MPF attribute word (0 when the file has no MPF index). */
  readonly mpfAttribute: number;
  readonly xmp: GainMapXmp | null;
  /** ISO 21496-1 metadata trimmed to its encoded length. */
  readonly iso: Buffer | null;
}

export interface PrimaryGainMapStructure {
  readonly xmp: GainMapXmp | null;
  readonly iso: Buffer | null;
  readonly mpf: {
    readonly attribute: number;
    readonly tiffStart: number;
  } | null;
}

export interface KeptGainMaps {
  readonly kind: 'kept';
  readonly primary: PrimaryGainMapStructure;
  /** In file order. */
  readonly gainMaps: readonly GainMapImage[];
}

export type GainMapAnalysis =
  | { readonly kind: 'none' }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | KeptGainMaps;

/** Rebuilt HDR segments (marker included) an image keeps; others are dropped. */
export interface KeptHdrSegments {
  readonly mpf?: Buffer;
  readonly iso?: Buffer;
  readonly xmp?: Buffer;
}

interface ImageHdr {
  readonly xmp: GainMapXmp | null;
  readonly iso: Buffer | null;
  readonly isoPresent: boolean;
  readonly mpf: JpegSegment | undefined;
}

interface LocatedImage {
  readonly start: number;
  readonly size: number;
  readonly mpfAttribute?: number;
  /** Listed as `GainMap` in the container directory. */
  readonly containerGainMap: boolean;
}

const NONE: GainMapAnalysis = { kind: 'none' };
const ISO_MULTICHANNEL = 0x80;
const ISO_COMMON_DENOMINATOR = 0x08;
const ISO_VERSION_BYTES = 4;

function unsupported(reason: string): GainMapAnalysis {
  return { kind: 'unsupported', reason };
}

/**
 * ISO 21496-1 metadata trimmed to its encoded length: the 4-byte version
 * block the primary image carries, or the full metadata of a gain map. An
 * unknown minimum version (which readers must skip) or a truncated block is
 * unusable (null).
 */
export function canonicalIsoMetadata(metadata: Buffer): Buffer | null {
  if (metadata.length < ISO_VERSION_BYTES || metadata.readUInt16BE(0) !== 0) {
    return null;
  }
  if (metadata.length === ISO_VERSION_BYTES) return metadata;
  const flags = metadata[ISO_VERSION_BYTES];
  const channels = flags & ISO_MULTICHANNEL ? 3 : 1;
  const size =
    ISO_VERSION_BYTES +
    1 +
    (flags & ISO_COMMON_DENOMINATOR ? 12 + channels * 20 : 16 + channels * 40);
  return metadata.length >= size ? metadata.subarray(0, size) : null;
}

function hasFullIsoMetadata(iso: Buffer | null): boolean {
  return iso !== null && iso.length > ISO_VERSION_BYTES;
}

function readImageHdr(image: Buffer, layout: JpegLayout): ImageHdr {
  const segments = firstHdrSegments(image, layout);
  return {
    xmp: segments.xmp
      ? parseGainMapXmp(payloadAfter(image, segments.xmp, XMP_SIGNATURE))
      : null,
    iso: segments.iso
      ? canonicalIsoMetadata(
          payloadAfter(image, segments.iso, ISO_GAIN_MAP_SIGNATURE)
        )
      : null,
    isoPresent: segments.iso !== undefined,
    mpf: segments.mpf
  };
}

function primarySignalsGainMap(primary: ImageHdr): boolean {
  return (
    primary.isoPresent ||
    hasGainMapProperty(primary.xmp, HDRGM_NS, 'Version') ||
    hasGainMapProperty(
      primary.xmp,
      APPLE_HDR_GAIN_MAP_NS,
      'HDRGainMapVersion'
    ) ||
    Boolean(primary.xmp?.directory?.some((item) => item.semantic === 'GainMap'))
  );
}

function startsWithSoi(input: Buffer, start: number): boolean {
  return input[start] === 0xff && input[start + 1] === SOI;
}

function mpfImages(
  input: Buffer,
  layout: JpegLayout,
  segment: JpegSegment
): { tiffStart: number; primaryAttribute: number; images: LocatedImage[] } {
  const tiffStart = segment.payloadStart + MPF_TIFF_OFFSET;
  const entries = parseMpfEntries(
    input.subarray(tiffStart, segment.payloadEnd)
  );
  if (entries[0].offset !== 0) {
    throw new GainMapStructureError(
      'MPF index does not start with the primary image'
    );
  }
  const images = entries
    .slice(1)
    .filter((entry) => entry.offset !== 0 || entry.size !== 0)
    .sort((a, b) => a.offset - b.offset)
    .map((entry): LocatedImage => {
      const start = tiffStart + entry.offset;
      if (
        start < layout.end ||
        entry.size < 4 ||
        start + entry.size > input.length ||
        !startsWithSoi(input, start)
      ) {
        throw new GainMapStructureError(
          'MPF entry does not point to a JPEG image after the primary image'
        );
      }
      return {
        start,
        size: entry.size,
        mpfAttribute: entry.attribute,
        containerGainMap: false
      };
    });
  // Disjoint images also bound the work of walking them to the file size.
  for (let index = 1; index < images.length; index++) {
    const previous = images[index - 1];
    if (images[index].start < previous.start + previous.size) {
      throw new GainMapStructureError('MPF entries overlap');
    }
  }
  return { tiffStart, primaryAttribute: entries[0].attribute, images };
}

/** Container items follow the primary image back to back, plus padding. */
function directoryImages(
  input: Buffer,
  layout: JpegLayout,
  directory: readonly ContainerItem[]
): LocatedImage[] {
  const [primary, ...items] = directory;
  if (primary.semantic !== 'Primary') {
    throw new GainMapStructureError(
      'Container directory does not start with the primary image'
    );
  }
  let cursor = layout.end + primary.padding;
  const images: LocatedImage[] = [];
  for (const item of items) {
    if (item.length === undefined) {
      throw new GainMapStructureError('Container item has no length');
    }
    images.push({
      start: cursor,
      size: item.length,
      containerGainMap: item.semantic === 'GainMap'
    });
    cursor += item.length + item.padding;
  }
  if (cursor > input.length) {
    throw new GainMapStructureError(
      'Container items run past the end of the file'
    );
  }
  return images;
}

function mergeLocated(
  fromMpf: readonly LocatedImage[],
  fromDirectory: readonly LocatedImage[]
): LocatedImage[] {
  const merged = fromMpf.map((image): LocatedImage => {
    const listed = fromDirectory.find((item) => item.start === image.start);
    return listed
      ? {
          ...image,
          size: Math.min(image.size, listed.size),
          containerGainMap: listed.containerGainMap
        }
      : image;
  });
  for (const listed of fromDirectory) {
    if (!fromMpf.some((image) => image.start === listed.start)) {
      merged.push(listed);
    }
  }
  return merged;
}

function isCandidate(image: LocatedImage): boolean {
  return (
    image.containerGainMap ||
    (image.mpfAttribute !== undefined &&
      isUndefinedJpegMpfType(image.mpfAttribute))
  );
}

function isGainMapImage(hdr: ImageHdr): boolean {
  return (
    hasHdrgmGainMapMetadata(hdr.xmp) ||
    isAppleGainMapXmp(hdr.xmp) ||
    hasFullIsoMetadata(hdr.iso)
  );
}

function walkCandidate(span: Buffer): JpegLayout | null {
  try {
    const layout = walkJpeg(span);
    return frameSize(span, layout) ? layout : null;
  } catch {
    return null;
  }
}

/** Null when the image is not a gain map (it is then dropped). */
function readCandidate(
  input: Buffer,
  located: LocatedImage
): GainMapImage | null {
  const span = input.subarray(located.start, located.start + located.size);
  const walked = walkCandidate(span);
  const image = walked ? span.subarray(0, walked.end) : null;
  const hdr = walked && image ? readImageHdr(image, walked) : null;
  if (!walked || !image || !hdr || !isGainMapImage(hdr)) {
    if (located.containerGainMap) {
      throw new GainMapStructureError(
        'Container gain map is not a JPEG image with gain map metadata'
      );
    }
    return null;
  }
  return {
    start: located.start,
    end: located.start + walked.end,
    image,
    layout: { ...walked, trailingBytes: 0 },
    mpfAttribute: located.mpfAttribute ?? 0,
    xmp: hdr.xmp,
    iso: hdr.iso
  };
}

function consistencyProblem(
  gainMaps: readonly GainMapImage[],
  located: readonly LocatedImage[],
  hasMpf: boolean
): string | null {
  const listed = located.filter((image) => image.containerGainMap);
  if (hasMpf && listed.some((image) => image.mpfAttribute === undefined)) {
    return 'MPF index does not list the container gain map';
  }
  if (
    listed.length &&
    (listed.length !== gainMaps.length ||
      listed.some((image) => !gainMaps.some((g) => g.start === image.start)))
  ) {
    return 'Container directory and gain map images disagree';
  }
  for (let index = 1; index < gainMaps.length; index++) {
    if (gainMaps[index].start < gainMaps[index - 1].end) {
      return 'Gain map images overlap';
    }
  }
  return null;
}

function findGainMaps(
  input: Buffer,
  layout: JpegLayout,
  primary: ImageHdr,
  signalled: boolean
): GainMapAnalysis {
  if (primary.xmp?.directoryMalformed && signalled) {
    throw new GainMapStructureError('Container directory is malformed');
  }
  const mpf = primary.mpf ? mpfImages(input, layout, primary.mpf) : null;
  const directory = primary.xmp?.directory
    ? directoryImages(input, layout, primary.xmp.directory)
    : [];
  const located = mergeLocated(mpf?.images ?? [], directory);
  const gainMaps = located
    .filter(isCandidate)
    .map((image) => readCandidate(input, image))
    .filter((image): image is GainMapImage => image !== null)
    .sort((a, b) => a.start - b.start);
  if (!gainMaps.length) {
    return signalled ? unsupported('No usable gain map image found') : NONE;
  }
  const problem = consistencyProblem(gainMaps, located, mpf !== null);
  if (problem) return unsupported(problem);
  return {
    kind: 'kept',
    primary: {
      xmp: primary.xmp,
      iso: primary.iso,
      mpf: mpf
        ? { attribute: mpf.primaryAttribute, tiffStart: mpf.tiffStart }
        : null
    },
    gainMaps
  };
}

/**
 * Decides whether the file's gain maps can be kept. Never throws: anything
 * unexpected in the secondary data drops the gain maps.
 */
export function analyzeGainMaps(
  input: Buffer,
  layout: JpegLayout
): GainMapAnalysis {
  let signalled = false;
  try {
    const primary = readImageHdr(input, layout);
    signalled = primarySignalsGainMap(primary);
    if (layout.trailingBytes === 0) {
      return signalled
        ? unsupported('No gain map image follows the primary image')
        : NONE;
    }
    return findGainMaps(input, layout, primary, signalled);
  } catch (error) {
    if (!signalled) return NONE;
    return unsupported(
      error instanceof GainMapStructureError
        ? error.message
        : 'Gain map structure could not be read'
    );
  }
}

// ----- Rebuilt segments -------------------------------------------------------

function isoSegment(iso: Buffer | null): Buffer | undefined {
  return iso
    ? jpegSegment(APP2, Buffer.concat([ISO_GAIN_MAP_SIGNATURE, iso]))
    : undefined;
}

function xmpSegment(
  xmp: GainMapXmp | null,
  directory: readonly OutputDirectoryItem[] | null
): Buffer | undefined {
  const payload = serializeGainMapXmp(xmp?.properties ?? [], directory);
  return payload ? jpegSegment(APP1, payload) : undefined;
}

/** A gain map keeps its ISO 21496-1 block and gain map XMP values only. */
export function gainMapImageSegments(gainMap: GainMapImage): KeptHdrSegments {
  return { iso: isoSegment(gainMap.iso), xmp: xmpSegment(gainMap.xmp, null) };
}

/**
 * MPF entries for the primary image and each kept gain map, in order.
 * `offsets` are relative to the MPF TIFF header. Null when the file has no
 * MPF index (then none is added).
 */
export function gainMapMpfEntries(
  kept: KeptGainMaps,
  primarySize: number,
  offsets: readonly number[],
  sizes: readonly number[]
): MpfEntry[] | null {
  if (!kept.primary.mpf) return null;
  return [
    {
      attribute: withoutDependencyFlags(kept.primary.mpf.attribute),
      size: primarySize,
      offset: 0
    },
    ...kept.gainMaps.map((gainMap, index) => ({
      attribute: withoutDependencyFlags(gainMap.mpfAttribute),
      size: sizes[index],
      offset: offsets[index]
    }))
  ];
}

/**
 * The primary image keeps a rebuilt MPF index, a minimal XMP packet (gain map
 * values and a Primary/GainMap container directory with the given gain map
 * sizes) and its ISO 21496-1 version block when every gain map has ISO
 * metadata.
 */
export function primaryImageSegments(
  kept: KeptGainMaps,
  gainMapSizes: readonly number[],
  mpfEntries: readonly MpfEntry[] | null
): KeptHdrSegments {
  const directory: OutputDirectoryItem[] | null = kept.primary.xmp?.directory
    ? [
        { semantic: 'Primary' },
        ...gainMapSizes.map(
          (length): OutputDirectoryItem => ({ semantic: 'GainMap', length })
        )
      ]
    : null;
  const isoEverywhere = kept.gainMaps.every((gainMap) =>
    hasFullIsoMetadata(gainMap.iso)
  );
  return {
    mpf: mpfEntries
      ? jpegSegment(APP2, buildMpfPayload(mpfEntries))
      : undefined,
    iso: isoEverywhere ? isoSegment(kept.primary.iso) : undefined,
    xmp: xmpSegment(kept.primary.xmp, directory)
  };
}

/** What the primary image's HDR segments must be for the file as it is. */
export function primaryImageSegmentsInPlace(
  kept: KeptGainMaps,
  layout: JpegLayout
): KeptHdrSegments {
  const sizes = kept.gainMaps.map((gainMap) => gainMap.end - gainMap.start);
  const tiffStart = kept.primary.mpf?.tiffStart ?? 0;
  const offsets = kept.gainMaps.map((gainMap) => gainMap.start - tiffStart);
  return primaryImageSegments(
    kept,
    sizes,
    gainMapMpfEntries(kept, layout.end, offsets, sizes)
  );
}
