import { MetadataCategory } from './metadata-category';

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;
const INTEROP_IFD_POINTER = 0xa005;
const GPS_VERSION_ID = 0x0000;
const MAX_IFD_ENTRIES = 1000;

/** Tags whose presence identifies a person, a device or a moment. */
const TAG_CATEGORIES: ReadonlyMap<number, MetadataCategory> = new Map([
  [0xa431, MetadataCategory.SERIAL], // BodySerialNumber
  [0xa435, MetadataCategory.SERIAL], // LensSerialNumber
  [0xc62f, MetadataCategory.SERIAL], // CameraSerialNumber (DNG)
  [0xa420, MetadataCategory.SERIAL], // ImageUniqueID
  [0x927c, MetadataCategory.SERIAL], // MakerNote, where vendors keep serials
  [0x013b, MetadataCategory.OWNER_ARTIST], // Artist
  [0x8298, MetadataCategory.OWNER_ARTIST], // Copyright
  [0xa430, MetadataCategory.OWNER_ARTIST], // CameraOwnerName
  [0x9c9d, MetadataCategory.OWNER_ARTIST], // XPAuthor
  [0x0132, MetadataCategory.CAPTURE_TIME], // DateTime
  [0x9003, MetadataCategory.CAPTURE_TIME], // DateTimeOriginal
  [0x9004, MetadataCategory.CAPTURE_TIME], // DateTimeDigitized
  [0x9010, MetadataCategory.CAPTURE_TIME], // OffsetTime
  [0x9011, MetadataCategory.CAPTURE_TIME], // OffsetTimeOriginal
  [0x9012, MetadataCategory.CAPTURE_TIME], // OffsetTimeDigitized
  [0x9290, MetadataCategory.CAPTURE_TIME], // SubSecTime
  [0x9291, MetadataCategory.CAPTURE_TIME], // SubSecTimeOriginal
  [0x9292, MetadataCategory.CAPTURE_TIME], // SubSecTimeDigitized
  [0x010f, MetadataCategory.CAMERA], // Make
  [0x0110, MetadataCategory.CAMERA], // Model
  [0xa433, MetadataCategory.CAMERA], // LensMake
  [0xa434, MetadataCategory.CAMERA], // LensModel
  [0x013c, MetadataCategory.CAMERA], // HostComputer
  [0x0201, MetadataCategory.THUMBNAIL], // JPEGInterchangeFormat
  [0x0202, MetadataCategory.THUMBNAIL], // JPEGInterchangeFormatLength
  [0x02bc, MetadataCategory.XMP_IPTC], // XMP packet
  [0x83bb, MetadataCategory.XMP_IPTC] // IPTC-NAA
]);

/**
 * Layout and colour tags that say nothing about who, where or when. An EXIF
 * block holding only these (and the IFD pointers) is technical, not
 * identifying. Any tag outside both lists counts as `other` and is stripped.
 */
const TECHNICAL_TAGS: ReadonlySet<number> = new Set([
  0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0112, 0x0115, 0x011a, 0x011b,
  0x011c, 0x0128, 0x013e, 0x013f, 0x0211, 0x0212, 0x0213, 0x0214, 0x8773,
  0x9000, 0x9101, 0xa000, 0xa001, 0xa002, 0xa003
]);

const POINTER_TAGS: ReadonlySet<number> = new Set([
  EXIF_IFD_POINTER,
  GPS_IFD_POINTER,
  INTEROP_IFD_POINTER
]);

interface TiffReader {
  readonly tiff: Buffer;
  readonly u16: (offset: number) => number;
  readonly u32: (offset: number) => number;
}

interface IfdEntry {
  readonly tag: number;
  readonly valueOffset: number;
}

interface Ifd {
  readonly entries: IfdEntry[];
  readonly next: number;
}

class MalformedTiff extends Error {}

function tiffReader(tiff: Buffer): TiffReader {
  if (tiff.length < 8) throw new MalformedTiff('short');
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') throw new MalformedTiff('order');
  const le = order === 'II';
  const reader: TiffReader = {
    tiff,
    u16: (offset) =>
      le ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset),
    u32: (offset) =>
      le ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset)
  };
  if (reader.u16(2) !== 42) throw new MalformedTiff('magic');
  return reader;
}

function readIfd(reader: TiffReader, offset: number): Ifd {
  const { tiff } = reader;
  if (offset < 8 || offset + 2 > tiff.length) throw new MalformedTiff('ifd');
  const count = reader.u16(offset);
  const end = offset + 2 + count * 12;
  if (count > MAX_IFD_ENTRIES || end > tiff.length) {
    throw new MalformedTiff('entries');
  }
  const entries: IfdEntry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12;
    entries.push({ tag: reader.u16(entry), valueOffset: entry + 8 });
  }
  const next = end + 4 <= tiff.length ? reader.u32(end) : 0;
  return { entries, next };
}

function categorizeTags(
  ifd: Ifd,
  categories: Set<MetadataCategory>
): Map<number, number> {
  const pointers = new Map<number, number>();
  for (const entry of ifd.entries) {
    if (POINTER_TAGS.has(entry.tag)) {
      pointers.set(entry.tag, entry.valueOffset);
      continue;
    }
    const category = TAG_CATEGORIES.get(entry.tag);
    if (category) categories.add(category);
    else if (!TECHNICAL_TAGS.has(entry.tag)) {
      categories.add(MetadataCategory.OTHER);
    }
  }
  return pointers;
}

function inspectGps(reader: TiffReader, offset: number): MetadataCategory {
  const gps = readIfd(reader, offset);
  return gps.entries.some((entry) => entry.tag !== GPS_VERSION_ID)
    ? MetadataCategory.GPS
    : MetadataCategory.OTHER;
}

function inspectSubIfds(
  reader: TiffReader,
  pointers: Map<number, number>,
  categories: Set<MetadataCategory>,
  visited: Set<number>
): void {
  const exifPointer = pointers.get(EXIF_IFD_POINTER);
  if (exifPointer !== undefined) {
    const offset = reader.u32(exifPointer);
    if (!visited.has(offset)) {
      visited.add(offset);
      const exifPointers = categorizeTags(readIfd(reader, offset), categories);
      // Interoperability entries are index/version only.
      exifPointers.delete(INTEROP_IFD_POINTER);
      inspectSubIfds(reader, exifPointers, categories, visited);
    }
  }
  const gpsPointer = pointers.get(GPS_IFD_POINTER);
  if (gpsPointer !== undefined) {
    const offset = reader.u32(gpsPointer);
    if (!visited.has(offset)) {
      visited.add(offset);
      categories.add(inspectGps(reader, offset));
    }
  }
}

/**
 * Identifying categories in one EXIF (TIFF) block. Values are never read,
 * only which tags exist. An empty result means a technical-only block; an
 * unreadable block counts as `other`.
 */
export function exifTiffCategories(tiff: Buffer): Set<MetadataCategory> {
  const categories = new Set<MetadataCategory>();
  try {
    const reader = tiffReader(tiff);
    const ifd0Offset = reader.u32(4);
    const ifd0 = readIfd(reader, ifd0Offset);
    const pointers = categorizeTags(ifd0, categories);
    inspectSubIfds(reader, pointers, categories, new Set([ifd0Offset]));
    if (ifd0.next !== 0 && ifd0.next !== ifd0Offset) {
      const ifd1 = readIfd(reader, ifd0.next);
      if (ifd1.entries.length) categories.add(MetadataCategory.THUMBNAIL);
    }
  } catch {
    categories.add(MetadataCategory.OTHER);
  }
  return categories;
}
