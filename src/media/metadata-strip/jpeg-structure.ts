import { assertWithin, LosslessStripUnsupported } from './metadata-strip.types';

export const SOI = 0xd8;
export const EOI = 0xd9;
const SOS = 0xda;
export const APP0 = 0xe0;
export const APP1 = 0xe1;
export const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;

const JFIF = Buffer.from('JFIF\0', 'latin1');
const EXIF = Buffer.from('Exif\0', 'latin1');
const XMP_PREFIX = Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1');
/** The standard XMP packet identifier, NUL included. */
export const XMP_SIGNATURE = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\0',
  'latin1'
);
const ICC_PROFILE = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE = Buffer.from('Adobe', 'latin1');
/** CIPA DC-007 Multi-Picture Format index. */
export const MPF_SIGNATURE = Buffer.from('MPF\0', 'latin1');
/** ISO 21496-1 gain map metadata. */
export const ISO_GAIN_MAP_SIGNATURE = Buffer.from(
  'urn:iso:std:iso:ts:21496:-1\0',
  'latin1'
);

export interface JpegSegment {
  readonly marker: number;
  /** Offset of the marker's 0xFF, after any fill bytes. */
  readonly start: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
  /** Segment end, including entropy-coded data after a scan header. */
  readonly end: number;
}

export interface JpegLayout {
  readonly segments: readonly JpegSegment[];
  /** Offset just after the EOI marker. */
  readonly end: number;
  readonly trailingBytes: number;
}

/** Segments that carry HDR gain map structure and may be rebuilt and kept. */
export type HdrSegmentKind = 'mpf' | 'iso' | 'xmp';

export type SegmentRole =
  | { readonly kind: 'render' }
  | { readonly kind: 'jfif' }
  | { readonly kind: 'exif' }
  | {
      readonly kind: 'hdr';
      readonly hdr: HdrSegmentKind;
      readonly label: string;
    }
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

/** Walks one JPEG image from its SOI (at offset 0) to its EOI. */
export function walkJpeg(input: Buffer): JpegLayout {
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
        return { segments, end, trailingBytes: input.length - end };
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

/** Stored size from the first frame header; null without a usable one. */
export function frameSize(
  input: Buffer,
  layout: JpegLayout
): { width: number; height: number } | null {
  const frame = layout.segments.find((segment) =>
    isFrameMarker(segment.marker)
  );
  if (!frame || frame.payloadEnd - frame.payloadStart < 5) return null;
  return {
    width: input.readUInt16BE(frame.payloadStart + 3),
    height: input.readUInt16BE(frame.payloadStart + 1)
  };
}

export function payloadStartsWith(
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

/** The payload after a signature the caller has already matched. */
export function payloadAfter(
  input: Buffer,
  segment: JpegSegment,
  signature: Buffer
): Buffer {
  return input.subarray(
    segment.payloadStart + signature.length,
    segment.payloadEnd
  );
}

export function segmentBytes(input: Buffer, segment: JpegSegment): Buffer {
  return input.subarray(segment.start, segment.end);
}

export function jpegSegment(marker: number, payload: Buffer): Buffer {
  if (payload.length + 2 > 0xffff) {
    throw new LosslessStripUnsupported('JPEG segment payload is too large');
  }
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function app1Role(input: Buffer, segment: JpegSegment): SegmentRole {
  if (payloadStartsWith(input, segment, EXIF)) return { kind: 'exif' };
  if (payloadStartsWith(input, segment, XMP_SIGNATURE)) {
    return { kind: 'hdr', hdr: 'xmp', label: 'APP1:XMP' };
  }
  return {
    kind: 'drop',
    label: payloadStartsWith(input, segment, XMP_PREFIX) ? 'APP1:XMP' : 'APP1'
  };
}

function app2Role(input: Buffer, segment: JpegSegment): SegmentRole {
  if (payloadStartsWith(input, segment, ICC_PROFILE)) return { kind: 'render' };
  if (payloadStartsWith(input, segment, MPF_SIGNATURE)) {
    return { kind: 'hdr', hdr: 'mpf', label: 'APP2:MPF' };
  }
  if (payloadStartsWith(input, segment, ISO_GAIN_MAP_SIGNATURE)) {
    return { kind: 'hdr', hdr: 'iso', label: 'APP2:ISO21496-1' };
  }
  return { kind: 'drop', label: 'APP2' };
}

function applicationSegmentRole(
  input: Buffer,
  segment: JpegSegment
): SegmentRole {
  switch (segment.marker) {
    case APP0:
      return payloadStartsWith(input, segment, JFIF)
        ? { kind: 'jfif' }
        : { kind: 'drop', label: 'APP0' };
    case APP1:
      return app1Role(input, segment);
    case APP2:
      return app2Role(input, segment);
    case APP14:
      return payloadStartsWith(input, segment, ADOBE)
        ? { kind: 'render' }
        : { kind: 'drop', label: 'APP14' };
    default:
      return { kind: 'drop', label: `APP${segment.marker - APP0}` };
  }
}

/**
 * Pixels, tables, ICC chunks (in order) and the Adobe colour-transform marker
 * render; JFIF is kept without its thumbnail; EXIF becomes Orientation only;
 * the standard XMP packet, MPF index and ISO 21496-1 block are HDR gain map
 * candidates that are rebuilt or dropped; comments and every other
 * application segment are dropped.
 */
export function segmentRole(input: Buffer, segment: JpegSegment): SegmentRole {
  if (segment.marker === COM) return { kind: 'drop', label: 'COM' };
  if (segment.marker >= APP0 && segment.marker <= APP15) {
    return applicationSegmentRole(input, segment);
  }
  return { kind: 'render' };
}

/** The first segment of each HDR kind; later copies are always dropped. */
export function firstHdrSegments(
  input: Buffer,
  layout: JpegLayout
): Partial<Record<HdrSegmentKind, JpegSegment>> {
  const found: Partial<Record<HdrSegmentKind, JpegSegment>> = {};
  for (const segment of layout.segments) {
    const role = segmentRole(input, segment);
    if (role.kind === 'hdr' && !found[role.hdr]) found[role.hdr] = segment;
  }
  return found;
}
