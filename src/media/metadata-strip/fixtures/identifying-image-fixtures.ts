import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import Sharp from 'sharp';

/**
 * Synthetic images carrying every kind of identifying metadata the privacy
 * strip must remove. All names, places, serials and times are invented.
 */
export const IDENTIFYING_STRINGS = [
  'SynthCam Make',
  'SynthCam Model X',
  'Jane Synthetic',
  'SYNTH-SERIAL-0001',
  '2026:01:02 03:04:05',
  '+05:30',
  'Synthville',
  'SynthEdit History',
  'owner@example.invalid',
  'SEFT-synthetic-trailer'
] as const;

const WIDTH = 32;
const HEIGHT = 16;

function gradientPixels(channels: 3 | 4): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * channels);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * channels;
      pixels[offset] = x * 8;
      pixels[offset + 1] = y * 16;
      pixels[offset + 2] = 255 - x * 4;
      if (channels === 4) pixels[offset + 3] = 128 + y * 8;
    }
  }
  return pixels;
}

// ----- TIFF/EXIF -----------------------------------------------------------

type TiffEntry =
  | { tag: number; ascii: string }
  | { tag: number; short: number }
  | { tag: number; long: number }
  | { tag: number; rationals: [number, number][] }
  | { tag: number; pointer: 'exif' | 'gps' | 'thumbnail' };

interface TiffIfd {
  readonly name: 'ifd0' | 'exif' | 'gps' | 'ifd1';
  readonly entries: TiffEntry[];
}

function entryData(entry: TiffEntry): { type: number; data: Buffer } {
  if ('ascii' in entry) {
    return { type: 2, data: Buffer.from(`${entry.ascii}\0`, 'latin1') };
  }
  if ('short' in entry) {
    const data = Buffer.alloc(2);
    data.writeUInt16LE(entry.short);
    return { type: 3, data };
  }
  if ('rationals' in entry) {
    const data = Buffer.alloc(entry.rationals.length * 8);
    entry.rationals.forEach(([numerator, denominator], index) => {
      data.writeUInt32LE(numerator, index * 8);
      data.writeUInt32LE(denominator, index * 8 + 4);
    });
    return { type: 5, data };
  }
  return { type: 4, data: Buffer.alloc(4) };
}

const evenLength = (length: number) => length + (length % 2);

/** Little-endian TIFF with IFD0 -> Exif/GPS IFDs and an IFD1 JPEG thumbnail. */
export function buildTiff(ifds: TiffIfd[], thumbnail?: Buffer): Buffer {
  const sizes = ifds.map((ifd) => {
    const extra = ifd.entries
      .map((entry) => entryData(entry).data.length)
      .filter((length) => length > 4)
      .reduce((total, length) => total + evenLength(length), 0);
    return 2 + ifd.entries.length * 12 + 4 + extra;
  });
  const offsets: Record<string, number> = {};
  let cursor = 8;
  ifds.forEach((ifd, index) => {
    offsets[ifd.name] = cursor;
    cursor += sizes[index];
  });
  offsets.thumbnail = cursor;
  const tiff = Buffer.alloc(cursor + (thumbnail?.length ?? 0));
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  ifds.forEach((ifd) => {
    const start = offsets[ifd.name];
    let dataCursor = start + 2 + ifd.entries.length * 12 + 4;
    tiff.writeUInt16LE(ifd.entries.length, start);
    ifd.entries.forEach((entry, entryIndex) => {
      const at = start + 2 + entryIndex * 12;
      const { type, data } = entryData(entry);
      tiff.writeUInt16LE(entry.tag, at);
      tiff.writeUInt16LE(type, at + 2);
      const count = type === 2 ? data.length : type === 5 ? data.length / 8 : 1;
      tiff.writeUInt32LE(count, at + 4);
      if ('pointer' in entry) {
        tiff.writeUInt32LE(offsets[entry.pointer], at + 8);
      } else if ('long' in entry) {
        tiff.writeUInt32LE(entry.long, at + 8);
      } else if (data.length <= 4) {
        data.copy(tiff, at + 8);
      } else {
        tiff.writeUInt32LE(dataCursor, at + 8);
        data.copy(tiff, dataCursor);
        dataCursor += evenLength(data.length);
      }
    });
    const next = ifd.name === 'ifd0' ? (offsets.ifd1 ?? 0) : 0;
    tiff.writeUInt32LE(next, start + 2 + ifd.entries.length * 12);
  });
  thumbnail?.copy(tiff, offsets.thumbnail);
  return tiff;
}

export async function syntheticThumbnail(): Promise<Buffer> {
  return Sharp({
    create: { width: 8, height: 4, channels: 3, background: '#a1b2c3' }
  })
    .jpeg({ quality: 50 })
    .toBuffer();
}

export function identifyingExifTiff(
  orientation: number,
  thumbnail?: Buffer
): Buffer {
  const ifds: TiffIfd[] = [
    {
      name: 'ifd0',
      entries: [
        { tag: 0x010f, ascii: 'SynthCam Make' },
        { tag: 0x0110, ascii: 'SynthCam Model X' },
        { tag: 0x0112, short: orientation },
        { tag: 0x013b, ascii: 'Jane Synthetic Artist' },
        { tag: 0x8769, pointer: 'exif' },
        { tag: 0x8825, pointer: 'gps' }
      ]
    },
    {
      name: 'exif',
      entries: [
        { tag: 0x9003, ascii: '2026:01:02 03:04:05' },
        { tag: 0x9011, ascii: '+05:30' },
        { tag: 0xa430, ascii: 'Jane Synthetic Owner' },
        { tag: 0xa431, ascii: 'SYNTH-SERIAL-0001' }
      ]
    },
    {
      name: 'gps',
      entries: [
        { tag: 0x0001, ascii: 'N' },
        {
          tag: 0x0002,
          rationals: [
            [37, 1],
            [48, 1],
            [3000, 100]
          ]
        },
        { tag: 0x0003, ascii: 'W' },
        {
          tag: 0x0004,
          rationals: [
            [122, 1],
            [25, 1],
            [1200, 100]
          ]
        }
      ]
    }
  ];
  if (thumbnail) {
    ifds.push({
      name: 'ifd1',
      entries: [
        { tag: 0x0103, short: 6 },
        { tag: 0x0201, pointer: 'thumbnail' },
        { tag: 0x0202, long: thumbnail.length }
      ]
    });
  }
  return buildTiff(ifds, thumbnail);
}

export const IDENTIFYING_XMP = Buffer.from(
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
    'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ' +
    'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" ' +
    'photoshop:City="Synthville XMP">' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Synthetic XMP</rdf:li></rdf:Seq></dc:creator>' +
    '<xmpMM:History>SynthEdit History</xmpMM:History>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
  'latin1'
);

// ----- JPEG ----------------------------------------------------------------

export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

export function iptcCityResource(): Buffer {
  const city = Buffer.from('Synthville IPTC', 'latin1');
  const dataset = Buffer.concat([
    Buffer.from([0x1c, 0x02, 0x5a, 0x00, city.length]),
    city
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataset.length);
  return Buffer.concat([
    Buffer.from('Photoshop 3.0\0', 'latin1'),
    Buffer.from('8BIM', 'latin1'),
    Buffer.from([0x04, 0x04, 0x00, 0x00]),
    size,
    dataset,
    Buffer.alloc(dataset.length % 2)
  ]);
}

export function jfifWithThumbnail(): Buffer {
  return Buffer.concat([
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([1, 2, 1, 0, 72, 0, 72, 2, 1]),
    Buffer.from('THUMB1', 'latin1')
  ]);
}

/** Inserts `segment` before the n-th (1-based) occurrence of a marker. */
function insertBeforeMarker(
  jpeg: Buffer,
  marker: number,
  occurrence: number,
  segment: Buffer
): Buffer {
  let found = 0;
  for (let index = 2; index < jpeg.length - 1; index++) {
    if (jpeg[index] === 0xff && jpeg[index + 1] === marker) {
      found++;
      if (found === occurrence) {
        return Buffer.concat([
          jpeg.subarray(0, index),
          segment,
          jpeg.subarray(index)
        ]);
      }
    }
  }
  throw new Error(`Marker ${marker.toString(16)} #${occurrence} not found`);
}

export interface IdentifyingJpeg {
  readonly jpeg: Buffer;
  readonly thumbnail: Buffer;
}

/**
 * Progressive Display P3 JPEG, Orientation 6, with JFIF thumbnail, full EXIF
 * (GPS, make/model, serial, owner, capture time and offset, embedded
 * thumbnail), XMP, IPTC City, comments (one between scans) and a trailer.
 */
export async function identifyingJpeg(): Promise<IdentifyingJpeg> {
  const base = await Sharp(gradientPixels(3), {
    raw: { width: WIDTH, height: HEIGHT, channels: 3 }
  })
    .withIccProfile('p3')
    .jpeg({ quality: 90, progressive: true })
    .toBuffer();
  const thumbnail = await syntheticThumbnail();
  const exif = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    identifyingExifTiff(6, thumbnail)
  ]);
  const header = Buffer.concat([
    base.subarray(0, 2),
    jpegSegment(0xe0, jfifWithThumbnail()),
    jpegSegment(0xe1, exif),
    jpegSegment(
      0xe1,
      Buffer.concat([
        Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
        IDENTIFYING_XMP
      ])
    ),
    jpegSegment(0xed, iptcCityResource()),
    jpegSegment(0xfe, Buffer.from('Comment owner@example.invalid', 'latin1'))
  ]);
  const withHeader = Buffer.concat([header, base.subarray(2)]);
  const withScanComment = insertBeforeMarker(
    withHeader,
    0xda,
    2,
    jpegSegment(0xfe, Buffer.from('Between scans Jane Synthetic', 'latin1'))
  );
  return {
    jpeg: Buffer.concat([
      withScanComment,
      Buffer.from('SEFT-synthetic-trailer', 'latin1')
    ]),
    thumbnail
  };
}

// ----- PNG -----------------------------------------------------------------

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

function insertPngChunks(
  png: Buffer,
  afterType: string,
  chunks: Buffer[]
): Buffer {
  let position = 8;
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    const type = png.toString('latin1', position + 4, position + 8);
    const end = position + 12 + length;
    if (type === afterType) {
      return Buffer.concat([
        png.subarray(0, end),
        ...chunks,
        png.subarray(end)
      ]);
    }
    position = end;
  }
  throw new Error(`PNG chunk ${afterType} not found`);
}

/** Display P3 RGBA PNG, Orientation 6, with tEXt/iTXt/zTXt/tIME/eXIf. */
export async function identifyingPng(): Promise<Buffer> {
  const base = await Sharp(gradientPixels(4), {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 }
  })
    .withIccProfile('p3')
    .png()
    .toBuffer();
  const time = Buffer.from([0x07, 0xea, 1, 2, 3, 4, 5]);
  const withHeaderChunks = insertPngChunks(base, 'IHDR', [
    pngChunk('tEXt', Buffer.from('Author\0Jane Synthetic PNG', 'latin1')),
    pngChunk(
      'iTXt',
      Buffer.concat([
        Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'),
        IDENTIFYING_XMP
      ])
    ),
    pngChunk(
      'zTXt',
      Buffer.concat([
        Buffer.from('Comment\0\0', 'latin1'),
        deflateSync(Buffer.from('owner@example.invalid', 'latin1'))
      ])
    ),
    pngChunk('tIME', time),
    pngChunk('eXIf', identifyingExifTiff(6))
  ]);
  return insertPngChunks(withHeaderChunks, 'IDAT', [
    pngChunk('tEXt', Buffer.from('Creation Time\0SynthEdit History', 'latin1'))
  ]);
}

// ----- GIF and WebP --------------------------------------------------------

export function animatedGifFixture(): Buffer {
  return readFileSync(
    join(__dirname, '../../../../scripts/media-fixtures/gif')
  );
}

function gifSubBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, offset + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function gifXmpExtension(): Buffer {
  const magicTrailer = Buffer.alloc(257);
  magicTrailer[0] = 0x01;
  for (let index = 1; index < 257; index++) magicTrailer[index] = 256 - index;
  return Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('XMP DataXMP', 'latin1'),
    IDENTIFYING_XMP,
    magicTrailer,
    Buffer.from([0x00])
  ]);
}

/** The two-frame looping GIF with comments, XMP and an unknown application block. */
export function identifyingGif(): Buffer {
  const gif = animatedGifFixture();
  const packed = gif[10];
  const headerEnd = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe]),
    gifSubBlocks(Buffer.from('GIF comment Jane Synthetic', 'latin1'))
  ]);
  const unknownApplication = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('SYNTHAPP1.0', 'latin1'),
    gifSubBlocks(Buffer.from('owner@example.invalid', 'latin1'))
  ]);
  const trailer = gif.length - 1;
  if (gif[trailer] !== 0x3b) throw new Error('GIF fixture lacks a trailer');
  return Buffer.concat([
    gif.subarray(0, headerEnd),
    comment,
    gifXmpExtension(),
    unknownApplication,
    gif.subarray(headerEnd, trailer),
    comment,
    gif.subarray(trailer)
  ]);
}

/** Lossless animated WebP with Display P3 ICC, EXIF and XMP chunks. */
export async function identifyingWebp(): Promise<Buffer> {
  return Sharp(animatedGifFixture(), { animated: true })
    .withIccProfile('p3')
    .withExif({
      IFD0: { Make: 'SynthCam Make', Artist: 'Jane Synthetic WebP' }
    })
    .withXmp(IDENTIFYING_XMP.toString('latin1'))
    .webp({ lossless: true })
    .toBuffer();
}

/** Extracts the ICC payload so tests can compare it byte for byte. */
export async function iccOf(image: Buffer): Promise<Buffer | undefined> {
  return (await Sharp(image).metadata()).icc;
}
