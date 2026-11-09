import {
  APPLE_HDR_GAIN_MAP_NS,
  APPLE_PIXEL_DATA_NS,
  CONTAINER_ITEM_NS,
  CONTAINER_NS,
  HDRGM_NS
} from '@/media/metadata-strip/gain-map-xmp';
import {
  extractJpegGainMaps,
  LosslessStripFormat
} from '@/media/metadata-strip/lossless-metadata-strip';
import { exifTiffCategories } from './exif-identifying-tags';
import { MetadataCategory } from './metadata-category';

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_EXTENSION = Buffer.from(
  'http://ns.adobe.com/xmp/extension/',
  'latin1'
);
const XMP_MAIN = Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1');
const XMP_START = Buffer.from('<x:xmpmeta', 'latin1');
const XMP_END = Buffer.from('</x:xmpmeta>', 'latin1');
const MAX_XMP_PACKET_BYTES = 1024 * 1024;
const GAIN_MAP_LABEL_PREFIX = 'GainMap:';
/** HDR gain map structure the strip rebuilds; it identifies nothing. */
const HDR_STRUCTURE_LABELS: ReadonlySet<string> = new Set([
  'APP2:MPF',
  'APP2:ISO21496-1'
]);
const GAIN_MAP_NAMESPACES: ReadonlySet<string> = new Set([
  HDRGM_NS,
  CONTAINER_NS,
  CONTAINER_ITEM_NS,
  APPLE_HDR_GAIN_MAP_NS,
  APPLE_PIXEL_DATA_NS
]);
const XMP_FRAME_NAMESPACES: ReadonlySet<string> = new Set([
  'adobe:ns:meta/',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/XML/1998/namespace'
]);
const NAMESPACE_DECLARATION = /xmlns(?::[\w.-]+)?\s*=\s*["']([^"']*)["']/g;

/** XMP property names, matched as text, that reveal each category. */
const XMP_SIGNALS: ReadonlyArray<readonly [MetadataCategory, RegExp]> = [
  [MetadataCategory.GPS, /GPS(?:Latitude|Longitude|Altitude|Position)/],
  [MetadataCategory.SERIAL, /SerialNumber|ImageUniqueID/],
  [
    MetadataCategory.OWNER_ARTIST,
    /dc:creator|tiff:Artist|OwnerName|photoshop:Credit|xmpRights:Owner|dc:rights|CreatorContactInfo|CopyrightOwner|ImageCreator/
  ],
  [
    MetadataCategory.CAPTURE_TIME,
    /DateTimeOriginal|DateTimeDigitized|xmp:CreateDate|photoshop:DateCreated/
  ],
  [MetadataCategory.CAMERA, /tiff:Make|tiff:Model|aux:Lens|LensModel|LensMake/],
  [MetadataCategory.THUMBNAIL, /xmp:Thumbnails|xmpGImg:image/]
];

/** IPTC IIM datasets (record 2) and Photoshop resources, as byte patterns. */
const IPTC_SIGNALS: ReadonlyArray<readonly [MetadataCategory, Buffer[]]> = [
  [
    MetadataCategory.OWNER_ARTIST,
    [
      Buffer.from([0x1c, 0x02, 0x50]), // By-line
      Buffer.from([0x1c, 0x02, 0x55]), // By-line title
      Buffer.from([0x1c, 0x02, 0x74]) // Copyright notice
    ]
  ],
  [
    MetadataCategory.CAPTURE_TIME,
    [
      Buffer.from([0x1c, 0x02, 0x37]), // Date created
      Buffer.from([0x1c, 0x02, 0x3c]), // Time created
      Buffer.from([0x1c, 0x02, 0x3e]) // Digital creation date
    ]
  ],
  [
    MetadataCategory.THUMBNAIL,
    [
      Buffer.from('8BIM\x04\x09', 'latin1'),
      Buffer.from('8BIM\x04\x0c', 'latin1')
    ]
  ]
];

const PNG_OWNER_KEYWORDS = /^(?:author|artist|copyright|owner|creator)$/i;
const PNG_TIME_KEYWORDS =
  /^(?:creation time|date|datetime|date:(?:create|modify|timestamp))$/i;
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';
const PNG_IPTC_KEYWORDS = /^raw profile type (?:iptc|8bim)$/i;
const PNG_GPS_KEYWORDS = /gps|location/i;

export interface MetadataFindings {
  /** Identifying categories present, sorted; empty when nothing identifies. */
  readonly categories: MetadataCategory[];
}

interface Segment {
  readonly marker: number;
  readonly payload: Buffer;
}

/** APPn and COM segments of a JPEG, including any between progressive scans. */
function jpegSegments(input: Buffer): Segment[] {
  const segments: Segment[] = [];
  let position = 2;
  while (position + 4 <= input.length) {
    if (input[position] !== 0xff) break;
    const marker = input[position + 1];
    if (marker === 0xff) {
      position++;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      position += 2;
      continue;
    }
    const length = input.readUInt16BE(position + 2);
    const end = position + 2 + length;
    if (length < 2 || end > input.length) break;
    segments.push({ marker, payload: input.subarray(position + 4, end) });
    position = marker === 0xda ? entropyEnd(input, end) : end;
  }
  return segments;
}

function entropyEnd(input: Buffer, from: number): number {
  let index = from;
  for (;;) {
    index = input.indexOf(0xff, index);
    if (index < 0 || index + 1 >= input.length) return input.length;
    const next = input[index + 1];
    if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
      index += next === 0xff ? 1 : 2;
    } else {
      return index;
    }
  }
}

interface Chunk {
  readonly type: string;
  readonly data: Buffer;
}

function pngChunks(input: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let position = 8;
  while (position + 8 <= input.length) {
    const length = input.readUInt32BE(position);
    const type = input.toString('latin1', position + 4, position + 8);
    const end = position + 12 + length;
    if (end > input.length) break;
    chunks.push({
      type,
      data: input.subarray(position + 8, position + 8 + length)
    });
    if (type === 'IEND') break;
    position = end;
  }
  return chunks;
}

function webpChunks(input: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let position = 12;
  while (position + 8 <= input.length) {
    const type = input.toString('latin1', position, position + 4);
    const size = input.readUInt32LE(position + 4);
    const end = position + 8 + size;
    if (end > input.length) break;
    chunks.push({ type, data: input.subarray(position + 8, end) });
    position = end + (size & 1);
  }
  return chunks;
}

function withoutExifHeader(block: Buffer): Buffer {
  return block.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)
    ? block.subarray(EXIF_HEADER.length)
    : block;
}

function startsWith(buffer: Buffer, prefix: Buffer | string): boolean {
  const bytes =
    typeof prefix === 'string' ? Buffer.from(prefix, 'latin1') : prefix;
  return (
    buffer.length >= bytes.length &&
    buffer.subarray(0, bytes.length).equals(bytes)
  );
}

function exifBlocks(input: Buffer, format: LosslessStripFormat): Buffer[] {
  switch (format) {
    case 'jpeg':
      return jpegSegments(input)
        .filter(
          (segment) =>
            segment.marker === 0xe1 && startsWith(segment.payload, EXIF_HEADER)
        )
        .map((segment) => segment.payload.subarray(EXIF_HEADER.length));
    case 'png':
      return pngChunks(input)
        .filter((chunk) => chunk.type === 'eXIf')
        .map((chunk) => withoutExifHeader(chunk.data));
    case 'webp':
      return webpChunks(input)
        .filter((chunk) => chunk.type === 'EXIF')
        .map((chunk) => withoutExifHeader(chunk.data));
    default:
      return [];
  }
}

function xmpPackets(input: Buffer): string[] {
  const packets: string[] = [];
  let from = 0;
  for (;;) {
    const start = input.indexOf(XMP_START, from);
    if (start < 0) return packets;
    const limit = Math.min(input.length, start + MAX_XMP_PACKET_BYTES);
    const endMarker = input.subarray(start, limit).indexOf(XMP_END);
    const end = endMarker < 0 ? limit : start + endMarker;
    packets.push(input.toString('latin1', start, end));
    from = end;
  }
}

function xmpSignalCategories(packet: string): MetadataCategory[] {
  return XMP_SIGNALS.filter(([, signal]) => signal.test(packet)).map(
    ([category]) => category
  );
}

/**
 * An HDR gain map packet: it declares a gain map namespace and nothing but
 * gain map and XMP framing namespaces, and no identifying property.
 */
function isGainMapOnlyPacket(packet: string): boolean {
  const namespaces = new Set<string>();
  const declarations = new RegExp(NAMESPACE_DECLARATION.source, 'g');
  for (
    let match = declarations.exec(packet);
    match !== null;
    match = declarations.exec(packet)
  ) {
    namespaces.add(match[1]);
  }
  const all = Array.from(namespaces);
  return (
    all.some((namespace) => GAIN_MAP_NAMESPACES.has(namespace)) &&
    all.every(
      (namespace) =>
        GAIN_MAP_NAMESPACES.has(namespace) ||
        XMP_FRAME_NAMESPACES.has(namespace)
    ) &&
    !xmpSignalCategories(packet).length
  );
}

function addXmpSignals(input: Buffer, categories: Set<MetadataCategory>): void {
  for (const packet of xmpPackets(input)) {
    xmpSignalCategories(packet).forEach((category) => categories.add(category));
  }
}

function addIptcSignals(payload: Buffer, categories: Set<MetadataCategory>) {
  categories.add(MetadataCategory.XMP_IPTC);
  for (const [category, patterns] of IPTC_SIGNALS) {
    if (patterns.some((pattern) => payload.includes(pattern))) {
      categories.add(category);
    }
  }
}

function pngTextKeyword(chunk: Chunk): string {
  const nul = chunk.data.indexOf(0);
  return chunk.data.toString(
    'latin1',
    0,
    nul < 0 ? Math.min(79, chunk.data.length) : nul
  );
}

function pngTextCategory(keyword: string): MetadataCategory {
  if (keyword === PNG_XMP_KEYWORD || PNG_IPTC_KEYWORDS.test(keyword)) {
    return MetadataCategory.XMP_IPTC;
  }
  if (PNG_OWNER_KEYWORDS.test(keyword)) return MetadataCategory.OWNER_ARTIST;
  if (PNG_TIME_KEYWORDS.test(keyword)) return MetadataCategory.CAPTURE_TIME;
  if (PNG_GPS_KEYWORDS.test(keyword)) return MetadataCategory.GPS;
  return MetadataCategory.OTHER;
}

function addPngTextCategories(
  input: Buffer,
  categories: Set<MetadataCategory>
) {
  for (const chunk of pngChunks(input)) {
    if (
      chunk.type === 'tEXt' ||
      chunk.type === 'zTXt' ||
      chunk.type === 'iTXt'
    ) {
      categories.add(pngTextCategory(pngTextKeyword(chunk)));
    }
  }
}

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP13 = 0xed;

/** APP0 other than JFIF: a JFXX thumbnail extension or something unknown. */
function app0Category(payload: Buffer): MetadataCategory | null {
  if (startsWith(payload, 'JFIF')) return null;
  return startsWith(payload, 'JFXX')
    ? MetadataCategory.THUMBNAIL
    : MetadataCategory.OTHER;
}

/** APP1 other than EXIF: XMP (main or extended) or something unknown. */
function app1Category(payload: Buffer): MetadataCategory | null {
  if (startsWith(payload, EXIF_HEADER)) return null;
  return startsWith(payload, XMP_EXTENSION) || startsWith(payload, XMP_MAIN)
    ? MetadataCategory.XMP_IPTC
    : MetadataCategory.OTHER;
}

function addJpegApplicationCategories(
  input: Buffer,
  marker: number,
  categories: Set<MetadataCategory>
): void {
  for (const segment of jpegSegments(input)) {
    if (segment.marker !== marker) continue;
    if (marker === APP13) {
      addIptcSignals(segment.payload, categories);
      continue;
    }
    const category =
      marker === APP0
        ? app0Category(segment.payload)
        : app1Category(segment.payload);
    if (category) categories.add(category);
  }
}

type LabelHandler = (
  input: Buffer,
  format: LosslessStripFormat,
  categories: Set<MetadataCategory>
) => void;

const addExif: LabelHandler = (input, format, categories) => {
  for (const tiff of exifBlocks(input, format)) {
    exifTiffCategories(tiff).forEach((category) => categories.add(category));
  }
};

/** XMP identifies, unless every packet is an HDR gain map packet. */
const addXmp: LabelHandler = (input, _format, categories) => {
  const packets = xmpPackets(input);
  if (packets.length && packets.every(isGainMapOnlyPacket)) return;
  categories.add(MetadataCategory.XMP_IPTC);
  addXmpSignals(input, categories);
};

const LABEL_HANDLERS: ReadonlyMap<string, LabelHandler> = new Map<
  string,
  LabelHandler
>([
  ['APP1:Exif', addExif],
  ['eXIf', addExif],
  ['EXIF', addExif],
  ['APP1:XMP', addXmp],
  ['XMP', addXmp],
  ['application:XMP DataXMP', addXmp],
  ['APP0:JFIF-thumbnail', (_i, _f, c) => c.add(MetadataCategory.THUMBNAIL)],
  ['tIME', (_i, _f, c) => c.add(MetadataCategory.CAPTURE_TIME)],
  ['tEXt', (input, _f, c) => addPngTextCategories(input, c)],
  ['zTXt', (input, _f, c) => addPngTextCategories(input, c)],
  [
    'iTXt',
    (input, _f, c) => {
      addPngTextCategories(input, c);
      addXmpSignals(input, c);
    }
  ],
  ['APP0', (input, _f, c) => addJpegApplicationCategories(input, APP0, c)],
  ['APP1', (input, _f, c) => addJpegApplicationCategories(input, APP1, c)],
  ['APP13', (input, _f, c) => addJpegApplicationCategories(input, APP13, c)]
]);

function classifyLabel(
  input: Buffer,
  format: LosslessStripFormat,
  label: string,
  categories: Set<MetadataCategory>
): void {
  if (HDR_STRUCTURE_LABELS.has(label)) return;
  if (label.startsWith(GAIN_MAP_LABEL_PREFIX)) {
    // Blocks inside a kept gain map image are judged on that image alone.
    const inner = label.slice(GAIN_MAP_LABEL_PREFIX.length);
    const gainMaps = format === 'jpeg' ? extractJpegGainMaps(input) : [];
    if (!gainMaps.length) categories.add(MetadataCategory.OTHER);
    for (const gainMap of gainMaps) {
      classifyLabel(gainMap, format, inner, categories);
    }
    return;
  }
  const handler = LABEL_HANDLERS.get(label);
  if (handler) handler(input, format, categories);
  else categories.add(MetadataCategory.OTHER);
}

/**
 * Classifies what the lossless strip would remove (`removedBlocks`, from the
 * strip module's container description) into identifying categories. The
 * strip module decides what is removed; this only explains it. Unrecognized
 * blocks count as `other`. A file whose removable blocks are only technical
 * EXIF tags, or HDR gain map structure the strip rebuilds, has no
 * categories, so it is not rewritten.
 */
export function findIdentifyingMetadata(
  input: Buffer,
  format: LosslessStripFormat,
  removedBlocks: readonly string[]
): MetadataFindings {
  const categories = new Set<MetadataCategory>();
  for (const label of Array.from(new Set(removedBlocks))) {
    classifyLabel(input, format, label, categories);
  }
  return {
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b))
  };
}
