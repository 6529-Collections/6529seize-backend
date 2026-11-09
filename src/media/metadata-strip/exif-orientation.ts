const ORIENTATION_TAG = 0x0112;
const SHORT_TYPE = 3;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

interface TiffReader {
  readonly u16: (offset: number) => number;
  readonly u32: (offset: number) => number;
}

/** EXIF in WebP and PNG is a bare TIFF block, but some writers keep the JPEG prefix. */
export function withoutExifHeader(block: Buffer): Buffer {
  return block.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)
    ? block.subarray(EXIF_HEADER.length)
    : block;
}

function tiffReader(tiff: Buffer): TiffReader | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const littleEndian = order === 'II';
  const reader: TiffReader = {
    u16: (offset) =>
      littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset),
    u32: (offset) =>
      littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)
  };
  return reader.u16(2) === 42 ? reader : null;
}

function firstIfd(tiff: Buffer, reader: TiffReader) {
  const offset = reader.u32(4);
  if (offset < 8 || offset + 2 > tiff.length) return null;
  const count = reader.u16(offset);
  const entriesEnd = offset + 2 + count * 12;
  if (entriesEnd > tiff.length) return null;
  return { offset, count, entriesEnd };
}

/** Orientation 1-8 from IFD0, as decoders apply it; anything unreadable is upright. */
export function readTiffOrientation(tiff: Buffer): number {
  const reader = tiffReader(tiff);
  const ifd = reader ? firstIfd(tiff, reader) : null;
  if (!reader || !ifd) return 1;
  for (let index = 0; index < ifd.count; index++) {
    const entry = ifd.offset + 2 + index * 12;
    if (reader.u16(entry) !== ORIENTATION_TAG) continue;
    if (reader.u16(entry + 2) !== SHORT_TYPE || reader.u32(entry + 4) < 1)
      return 1;
    const value = reader.u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** A 26-byte big-endian TIFF whose only content is IFD0 Orientation. */
export function minimalOrientationTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(SHORT_TYPE, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  return tiff;
}

/** True only for an EXIF block that carries Orientation and nothing else. */
export function isOrientationOnlyTiff(tiff: Buffer): boolean {
  const reader = tiffReader(tiff);
  const ifd = reader ? firstIfd(tiff, reader) : null;
  if (!reader || !ifd || ifd.count !== 1) return false;
  const entry = ifd.offset + 2;
  return (
    reader.u16(entry) === ORIENTATION_TAG &&
    reader.u16(entry + 2) === SHORT_TYPE &&
    reader.u32(entry + 4) === 1 &&
    ifd.entriesEnd + 4 <= tiff.length &&
    reader.u32(ifd.entriesEnd) === 0 &&
    tiff.length <= 32
  );
}

export function minimalOrientationJpegExifPayload(orientation: number): Buffer {
  return Buffer.concat([EXIF_HEADER, minimalOrientationTiff(orientation)]);
}
