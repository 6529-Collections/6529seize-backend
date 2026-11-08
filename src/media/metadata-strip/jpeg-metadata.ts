import {
  isOrientationOnlyTiff,
  minimalOrientationJpegExifPayload,
  readTiffOrientation
} from './exif-orientation';
import {
  assertWithin,
  ContainerDescription,
  FormatMetadataStripper,
  LosslessStripUnsupported,
  newRenderHash
} from './metadata-strip.types';

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;

const JFIF = Buffer.from('JFIF\0', 'latin1');
const EXIF = Buffer.from('Exif\0', 'latin1');
const XMP = Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1');
const ICC_PROFILE = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE = Buffer.from('Adobe', 'latin1');
/** 'JFIF\0', version, units, X/Y density and the X/Y thumbnail size. */
const JFIF_HEADER_BYTES = 14;

interface JpegSegment {
  readonly marker: number;
  /** Offset of the marker's 0xFF, after any fill bytes. */
  readonly start: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  /** Segment end, including entropy-coded data after a scan header. */
  readonly end: number;
}

interface JpegLayout {
  readonly segments: readonly JpegSegment[];
  readonly trailingBytes: number;
}

type SegmentRole =
  | { readonly kind: 'render' }
  | { readonly kind: 'jfif' }
  | { readonly kind: 'exif' }
  | { readonly kind: 'drop'; readonly label: string };

function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function isFrameMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/** Position of the marker byte pair, skipping optional 0xFF fill bytes. */
function markerStart(input: Buffer, position: number): number {
  if (position + 1 >= input.length || input[position] !== 0xff) {
    throw new LosslessStripUnsupported('JPEG marker expected before EOI');
  }
  let start = position;
  while (start + 1 < input.length && input[start + 1] === 0xff) start++;
  if (start + 1 >= input.length) {
    throw new LosslessStripUnsupported('JPEG ends before EOI');
  }
  return start;
}

/** Entropy-coded data runs to the first marker that is not a restart marker. */
function entropyEnd(input: Buffer, from: number): number {
  let index = from;
  for (;;) {
    index = input.indexOf(0xff, index);
    if (index < 0 || index + 1 >= input.length) {
      throw new LosslessStripUnsupported('Unterminated JPEG scan');
    }
    const next = input[index + 1];
    if (next === 0xff) {
      index += 1;
    } else if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
      index += 2;
    } else {
      return index;
    }
  }
}

function walkJpeg(input: Buffer): JpegLayout {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== SOI) {
    throw new LosslessStripUnsupported('Not a JPEG');
  }
  const segments: JpegSegment[] = [];
  let position = 2;
  for (;;) {
    const start = markerStart(input, position);
    const marker = input[start + 1];
    if (marker === EOI || isStandaloneMarker(marker)) {
      const end = start + 2;
      segments.push({ marker, start, payloadStart: end, payloadEnd: end, end });
      if (marker === EOI) {
        return { segments, trailingBytes: input.length - end };
      }
      position = end;
      continue;
    }
    if (marker === SOI || marker === 0x00) {
      throw new LosslessStripUnsupported('Unexpected JPEG marker');
    }
    assertWithin(input, start + 4, 'JPEG segment');
    const length = input.readUInt16BE(start + 2);
    const payloadEnd = start + 2 + length;
    if (length < 2) throw new LosslessStripUnsupported('Invalid JPEG segment');
    assertWithin(input, payloadEnd, 'JPEG segment');
    const end = marker === SOS ? entropyEnd(input, payloadEnd) : payloadEnd;
    segments.push({ marker, start, payloadStart: start + 4, payloadEnd, end });
    position = end;
  }
}

function payloadStartsWith(
  input: Buffer,
  segment: JpegSegment,
  signature: Buffer
): boolean {
  return (
    segment.payloadEnd - segment.payloadStart >= signature.length &&
    input
      .subarray(segment.payloadStart, segment.payloadStart + signature.length)
      .equals(signature)
  );
}

function applicationSegmentRole(
  input: Buffer,
  segment: JpegSegment
): SegmentRole {
  const is = (signature: Buffer) =>
    payloadStartsWith(input, segment, signature);
  switch (segment.marker) {
    case APP0:
      return is(JFIF) ? { kind: 'jfif' } : { kind: 'drop', label: 'APP0' };
    case APP1:
      if (is(EXIF)) return { kind: 'exif' };
      return { kind: 'drop', label: is(XMP) ? 'APP1:XMP' : 'APP1' };
    case APP2:
      return is(ICC_PROFILE)
        ? { kind: 'render' }
        : { kind: 'drop', label: 'APP2' };
    case APP14:
      return is(ADOBE) ? { kind: 'render' } : { kind: 'drop', label: 'APP14' };
    default:
      return { kind: 'drop', label: `APP${segment.marker - APP0}` };
  }
}

/**
 * Pixels, tables, ICC chunks (in order) and the Adobe colour-transform marker
 * render; JFIF is kept without its thumbnail; EXIF becomes Orientation only;
 * comments and every other application segment are dropped.
 */
function segmentRole(input: Buffer, segment: JpegSegment): SegmentRole {
  if (segment.marker === COM) return { kind: 'drop', label: 'COM' };
  if (segment.marker >= APP0 && segment.marker <= APP15) {
    return applicationSegmentRole(input, segment);
  }
  return { kind: 'render' };
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
  if (!jfifHasThumbnail(input, segment)) {
    return input.subarray(segment.start, segment.end);
  }
  const output = Buffer.alloc(4 + JFIF_HEADER_BYTES);
  output[0] = 0xff;
  output[1] = APP0;
  output.writeUInt16BE(2 + JFIF_HEADER_BYTES, 2);
  input.copy(output, 4, segment.payloadStart, segment.payloadStart + 12);
  return output;
}

function applicationSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function strip(input: Buffer): Buffer {
  const { segments } = walkJpeg(input);
  const parts: Buffer[] = [input.subarray(0, 2)];
  let exifSeen = false;
  for (const segment of segments) {
    const role = segmentRole(input, segment);
    if (role.kind === 'render') {
      parts.push(input.subarray(segment.start, segment.end));
    } else if (role.kind === 'jfif') {
      parts.push(jfifWithoutThumbnail(input, segment));
    } else if (role.kind === 'exif' && !exifSeen) {
      exifSeen = true;
      const orientation = readTiffOrientation(exifTiff(input, segment));
      if (orientation !== 1) {
        parts.push(
          applicationSegment(
            APP1,
            minimalOrientationJpegExifPayload(orientation)
          )
        );
      }
    }
  }
  return Buffer.concat(parts);
}

function describe(input: Buffer): ContainerDescription {
  const { segments, trailingBytes } = walkJpeg(input);
  const metadataBlocks: string[] = [];
  let frame: JpegSegment | undefined;
  let orientation: number | undefined;
  const hash = newRenderHash();
  for (const segment of segments) {
    const role = segmentRole(input, segment);
    if (role.kind === 'render') {
      hash.update(input.subarray(segment.start, segment.end));
      if (!frame && isFrameMarker(segment.marker)) frame = segment;
    } else if (role.kind === 'jfif') {
      if (jfifHasThumbnail(input, segment)) {
        metadataBlocks.push('APP0:JFIF-thumbnail');
      }
    } else if (role.kind === 'exif') {
      const tiff = exifTiff(input, segment);
      orientation ??= readTiffOrientation(tiff);
      if (!isOrientationOnlyTiff(tiff)) metadataBlocks.push('APP1:Exif');
    } else {
      metadataBlocks.push(role.label);
    }
  }
  if (trailingBytes > 0) metadataBlocks.push('trailing-data');
  if (!frame || frame.payloadEnd - frame.payloadStart < 5) {
    throw new LosslessStripUnsupported('JPEG has no frame header');
  }
  return {
    width: input.readUInt16BE(frame.payloadStart + 3),
    height: input.readUInt16BE(frame.payloadStart + 1),
    orientation: orientation ?? 1,
    renderDigest: hash.digest('hex'),
    metadataBlocks
  };
}

export const jpegMetadataStripper: FormatMetadataStripper = {
  strip,
  describe
};
