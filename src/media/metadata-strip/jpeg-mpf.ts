import { MPF_SIGNATURE } from './jpeg-structure';

/**
 * CIPA DC-007 Multi-Picture Format index, as written in the primary image's
 * APP2 segment after `MPF\0`: a TIFF header, an MP Index IFD and one 16-byte
 * entry per image. Entry offsets are relative to that TIFF header; the
 * primary image's entry has offset 0.
 */
export interface MpfEntry {
  /** Flags (bits 31-27), image format (bits 26-24) and MP type (bits 23-0). */
  readonly attribute: number;
  readonly size: number;
  readonly offset: number;
}

/** A gain map structure that cannot be trusted; the gain map is dropped. */
export class GainMapStructureError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

const MP_FORMAT_VERSION = 0xb000;
const NUMBER_OF_IMAGES = 0xb001;
const MP_ENTRY = 0xb002;
const TYPE_LONG = 4;
const TYPE_UNDEFINED = 7;
const ENTRY_BYTES = 16;
const MAX_IMAGES = 64;
const MAX_IFD_ENTRIES = 256;
/** Dependent parent and child flags refer to entries a rebuilt index drops. */
const DEPENDENT_IMAGE_FLAGS = 0xc0000000;

/** Offset of the TIFF header inside an MPF APP2 payload. */
export const MPF_TIFF_OFFSET = MPF_SIGNATURE.length;

interface TiffReader {
  readonly u16: (offset: number) => number;
  readonly u32: (offset: number) => number;
}

function tiffReader(tiff: Buffer): TiffReader {
  const order = tiff.length >= 8 ? tiff.toString('latin1', 0, 2) : '';
  if (order !== 'II' && order !== 'MM') {
    throw new GainMapStructureError('MPF index has no TIFF header');
  }
  const littleEndian = order === 'II';
  const reader: TiffReader = {
    u16: (offset) =>
      littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset),
    u32: (offset) =>
      littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)
  };
  if (reader.u16(2) !== 42) {
    throw new GainMapStructureError('MPF index has no TIFF header');
  }
  return reader;
}

interface MpIndexTags {
  numberOfImages?: number;
  entriesOffset?: number;
  entriesBytes?: number;
}

function readIndexTags(tiff: Buffer, reader: TiffReader): MpIndexTags {
  const ifd = reader.u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) {
    throw new GainMapStructureError('MPF index IFD is out of range');
  }
  const count = reader.u16(ifd);
  if (count > MAX_IFD_ENTRIES || ifd + 2 + count * 12 > tiff.length) {
    throw new GainMapStructureError('MPF index IFD is out of range');
  }
  const tags: MpIndexTags = {};
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    const tag = reader.u16(entry);
    const type = reader.u16(entry + 2);
    const valueCount = reader.u32(entry + 4);
    if (tag === NUMBER_OF_IMAGES && type === TYPE_LONG && valueCount === 1) {
      tags.numberOfImages = reader.u32(entry + 8);
    } else if (tag === MP_ENTRY && type === TYPE_UNDEFINED) {
      tags.entriesBytes = valueCount;
      tags.entriesOffset = valueCount <= 4 ? entry + 8 : reader.u32(entry + 8);
    }
  }
  return tags;
}

/** Parses the MP Index entries from the TIFF block that follows `MPF\0`. */
export function parseMpfEntries(tiff: Buffer): MpfEntry[] {
  const reader = tiffReader(tiff);
  const { numberOfImages, entriesOffset, entriesBytes } = readIndexTags(
    tiff,
    reader
  );
  if (
    numberOfImages === undefined ||
    entriesOffset === undefined ||
    numberOfImages < 1 ||
    numberOfImages > MAX_IMAGES ||
    entriesBytes !== numberOfImages * ENTRY_BYTES ||
    entriesOffset + entriesBytes > tiff.length
  ) {
    throw new GainMapStructureError('MPF index entries are inconsistent');
  }
  const entries: MpfEntry[] = [];
  for (let index = 0; index < numberOfImages; index++) {
    const at = entriesOffset + index * ENTRY_BYTES;
    entries.push({
      attribute: reader.u32(at),
      size: reader.u32(at + 4),
      offset: reader.u32(at + 8)
    });
  }
  return entries;
}

/** MP type 0x000000 (Undefined) in JPEG format, as gain maps are written. */
export function isUndefinedJpegMpfType(attribute: number): boolean {
  return (attribute & 0x07ffffff) === 0;
}

export function withoutDependencyFlags(attribute: number): number {
  return (attribute & ~DEPENDENT_IMAGE_FLAGS) >>> 0;
}

/**
 * A minimal big-endian MP Index (version, image count and entries, no image
 * UIDs or attribute IFDs), `MPF\0` included. Its length depends only on the
 * number of entries, so callers can lay out the file before the offsets are
 * known and write the final index in place.
 */
export function buildMpfPayload(entries: readonly MpfEntry[]): Buffer {
  const ifdEntries = 3;
  const entriesOffset = 8 + 2 + ifdEntries * 12 + 4;
  const tiff = Buffer.alloc(entriesOffset + entries.length * ENTRY_BYTES);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(ifdEntries, 8);
  const tags: [number, number, number, number | Buffer][] = [
    [MP_FORMAT_VERSION, TYPE_UNDEFINED, 4, Buffer.from('0100', 'latin1')],
    [NUMBER_OF_IMAGES, TYPE_LONG, 1, entries.length],
    [MP_ENTRY, TYPE_UNDEFINED, entries.length * ENTRY_BYTES, entriesOffset]
  ];
  tags.forEach(([tag, type, count, value], index) => {
    const at = 10 + index * 12;
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    if (Buffer.isBuffer(value)) value.copy(tiff, at + 8);
    else tiff.writeUInt32BE(value, at + 8);
  });
  tiff.writeUInt32BE(0, 10 + ifdEntries * 12);
  entries.forEach((entry, index) => {
    const at = entriesOffset + index * ENTRY_BYTES;
    tiff.writeUInt32BE(entry.attribute >>> 0, at);
    tiff.writeUInt32BE(entry.size, at + 4);
    tiff.writeUInt32BE(entry.offset, at + 8);
  });
  return Buffer.concat([MPF_SIGNATURE, tiff]);
}
