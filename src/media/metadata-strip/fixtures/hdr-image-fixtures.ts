import Sharp from 'sharp';
import {
  identifyingExifTiff,
  iptcCityResource,
  jfifWithThumbnail,
  jpegSegment,
  syntheticThumbnail
} from './identifying-image-fixtures';

/**
 * Synthetic HDR gain map JPEGs, assembled by hand from sharp-encoded images:
 * an Ultra HDR file (gain map v1 XMP, Google container directory, ISO
 * 21496-1 and an MPF index) and an Apple-style HDR file (MPF index plus an
 * `urn:com:apple:photo:2020:aux:hdrgainmap` auxiliary image). The primary
 * image and the gain map both carry identifying metadata, and each file has
 * secondary images a strip must drop. Every value is invented.
 */

const SOI = Buffer.from([0xff, 0xd8]);
const XMP_ID = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const ISO_ID = Buffer.from('urn:iso:std:iso:ts:21496:-1\0', 'latin1');
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

export const MPF_PRIMARY_TYPE = 0x00030000;
export const MPF_REPRESENTATIVE = 0x20000000;
export const MPF_DEPENDENT_PARENT = 0x80000000;
export const MPF_UNDEFINED_TYPE = 0x00000000;
export const MPF_LARGE_THUMBNAIL_TYPE = 0x00010001;

function pattern(
  width: number,
  height: number,
  channels: 1 | 3,
  seed: number
): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  for (let index = 0; index < pixels.length; index++) {
    pixels[index] = (index * seed + (index >> 4) * 17) & 0xff;
  }
  return pixels;
}

async function jpegOf(
  width: number,
  height: number,
  channels: 1 | 3,
  seed: number,
  p3 = false
): Promise<Buffer> {
  const image = Sharp(pattern(width, height, channels, seed), {
    raw: { width, height, channels }
  });
  return (p3 ? image.withIccProfile('p3') : image)
    .jpeg({ quality: 90 })
    .toBuffer();
}

function withHeader(base: Buffer, segments: Buffer[]): Buffer {
  return Buffer.concat([SOI, ...segments, base.subarray(2)]);
}

function xmpSegment(xml: string): Buffer {
  return jpegSegment(0xe1, Buffer.concat([XMP_ID, Buffer.from(xml, 'utf8')]));
}

function isoSegment(metadata: Buffer): Buffer {
  return jpegSegment(0xe2, Buffer.concat([ISO_ID, metadata]));
}

function exifSegment(thumbnail?: Buffer): Buffer {
  return jpegSegment(
    0xe1,
    Buffer.concat([
      Buffer.from('Exif\0\0', 'latin1'),
      identifyingExifTiff(1, thumbnail)
    ])
  );
}

function comment(text: string): Buffer {
  return jpegSegment(0xfe, Buffer.from(text, 'latin1'));
}

/** ISO 21496-1 version block, as the primary image carries it. */
export const ISO_VERSION_ONLY = Buffer.from([0, 0, 0, 0]);

/** Multichannel, common-denominator ISO 21496-1 gain map metadata. */
export function isoGainMapMetadata(): Buffer {
  const channels = 3;
  const metadata = Buffer.alloc(5 + 12 + channels * 20);
  metadata[4] = 0x80 | 0x08;
  metadata.writeUInt32BE(65536, 5);
  metadata.writeUInt32BE(0, 9);
  metadata.writeUInt32BE(150732, 13);
  for (let channel = 0; channel < channels; channel++) {
    const at = 17 + channel * 20;
    metadata.writeInt32BE(0, at);
    metadata.writeInt32BE(150732 - channel * 1000, at + 4);
    metadata.writeUInt32BE(65536, at + 8);
    metadata.writeInt32BE(1024, at + 12);
    metadata.writeInt32BE(1024, at + 16);
  }
  return metadata;
}

const IDENTIFYING_DESCRIPTION =
  `<rdf:Description rdf:about="" ` +
  'xmlns:xmp="http://ns.adobe.com/xap/1.0/" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ' +
  'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" ' +
  'xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" ' +
  'xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
  'xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ' +
  'xmp:CreatorTool="SynthCam Model X" ' +
  'xmp:CreateDate="2026:01:02 03:04:05" ' +
  'photoshop:City="Synthville XMP" ' +
  'exif:GPSLatitude="37,48.5N" ' +
  'tiff:Make="SynthCam Make">' +
  '<dc:creator><rdf:Seq><rdf:li>Jane Synthetic XMP</rdf:li></rdf:Seq></dc:creator>' +
  '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource">' +
  '<stEvt:action>saved</stEvt:action>' +
  '<stEvt:softwareAgent>SynthEdit History</stEvt:softwareAgent>' +
  '</rdf:li></rdf:Seq></xmpMM:History>' +
  '</rdf:Description>';

function xmpPacket(descriptions: string): string {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="SynthEdit History">\n' +
    ` <rdf:RDF xmlns:rdf="${RDF}">\n  ${descriptions}\n </rdf:RDF>\n` +
    '</x:xmpmeta>\n' +
    `${' '.repeat(64)}\n<?xpacket end="w"?>`
  );
}

/**
 * Ultra HDR primary XMP: identifying properties in one description, and the
 * gain map version and container directory (with exiftool's `GContainer`
 * prefix and three item spellings) in another.
 */
function ultraHdrPrimaryXmp(gainMapLength: number, depthLength: number) {
  return xmpPacket(
    IDENTIFYING_DESCRIPTION +
      '<rdf:Description rdf:about="" ' +
      'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ' +
      'xmlns:GContainer="http://ns.google.com/photos/1.0/container/" ' +
      'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ' +
      'hdrgm:Version="1.0">' +
      '<GContainer:Directory><rdf:Seq>' +
      '<rdf:li rdf:parseType="Resource"><GContainer:Item ' +
      'Item:Semantic="Primary" Item:Mime="image/jpeg" Item:Padding="0"/></rdf:li>' +
      '<rdf:li rdf:parseType="Resource"><GContainer:Item rdf:parseType="Resource">' +
      '<Item:Semantic>GainMap</Item:Semantic><Item:Mime>image/jpeg</Item:Mime>' +
      `<Item:Length>${gainMapLength}</Item:Length></GContainer:Item></rdf:li>` +
      '<rdf:li><GContainer:Item Item:Semantic="Depth" Item:Mime="image/jpeg" ' +
      `Item:Length="${depthLength}"/></rdf:li>` +
      '</rdf:Seq></GContainer:Directory></rdf:Description>'
  );
}

/** Gain map v1 values (one per-channel rdf:Seq) beside identifying data. */
const ULTRA_HDR_GAIN_MAP_XMP = xmpPacket(
  '<rdf:Description rdf:about="" ' +
    'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" ' +
    'hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:Gamma="1" ' +
    'hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" ' +
    'hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3" ' +
    'hdrgm:BaseRenditionIsHDR="False">' +
    '<hdrgm:GainMapMax><rdf:Seq><rdf:li>2.3</rdf:li><rdf:li>2.25</rdf:li>' +
    '<rdf:li>2.2</rdf:li></rdf:Seq></hdrgm:GainMapMax>' +
    '<hdrgm:Comment>owner@example.invalid</hdrgm:Comment>' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Synthetic XMP</rdf:li></rdf:Seq></dc:creator>' +
    '<xmpMM:History>SynthEdit History</xmpMM:History>' +
    '</rdf:Description>'
);

const DEPTH_XMP = xmpPacket(
  '<rdf:Description rdf:about="" ' +
    'xmlns:GDepth="http://ns.google.com/photos/1.0/depthmap/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" GDepth:Format="RangeInverse">' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Synthetic XMP</rdf:li></rdf:Seq></dc:creator>' +
    '</rdf:Description>'
);

/** Apple writes its gain map values as elements. */
const APPLE_GAIN_MAP_XMP = xmpPacket(
  '<rdf:Description rdf:about="" ' +
    'xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/" ' +
    'xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/" ' +
    'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ' +
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
    '<HDRGainMap:HDRGainMapVersion>131072</HDRGainMap:HDRGainMapVersion>' +
    '<HDRGainMap:HDRGainMapHeadroom>3.4</HDRGainMap:HDRGainMapHeadroom>' +
    '<apdi:NativeFormat>1278226488</apdi:NativeFormat>' +
    '<apdi:AuxiliaryImageType>urn:com:apple:photo:2020:aux:hdrgainmap</apdi:AuxiliaryImageType>' +
    '<apdi:StoredFormat>1278226488</apdi:StoredFormat>' +
    '<photoshop:City>Synthville XMP</photoshop:City>' +
    '<xmp:CreateDate>2026:01:02 03:04:05</xmp:CreateDate>' +
    '</rdf:Description>'
);

const APPLE_MATTE_XMP = xmpPacket(
  '<rdf:Description rdf:about="" ' +
    'xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<apdi:AuxiliaryImageType>urn:com:apple:photo:2018:aux:portraiteffectsmatte</apdi:AuxiliaryImageType>' +
    '<dc:creator><rdf:Seq><rdf:li>Jane Synthetic XMP</rdf:li></rdf:Seq></dc:creator>' +
    '</rdf:Description>'
);

const APPLE_PRIMARY_XMP = xmpPacket(IDENTIFYING_DESCRIPTION);

// ----- MPF ------------------------------------------------------------------

interface MpfFixtureEntry {
  readonly attribute: number;
  readonly size: number;
  readonly offset: number;
}

/**
 * An MP Index with version, image count, entries and image UIDs, followed by
 * an MP Attribute IFD, as cameras write it.
 */
function mpfPayload(
  entries: readonly MpfFixtureEntry[],
  littleEndian: boolean
): Buffer {
  const count = entries.length;
  const indexIfd = 8;
  const indexTags = 4;
  const attributeIfd = indexIfd + 2 + indexTags * 12 + 4;
  const entriesAt = attributeIfd + 2 + 12 + 4;
  const uidsAt = entriesAt + count * 16;
  const tiff = Buffer.alloc(uidsAt + count * 33);
  const u16 = (value: number, at: number) =>
    littleEndian
      ? tiff.writeUInt16LE(value, at)
      : tiff.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) =>
    littleEndian
      ? tiff.writeUInt32LE(value >>> 0, at)
      : tiff.writeUInt32BE(value >>> 0, at);
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(indexIfd, 4);
  u16(indexTags, indexIfd);
  const tag = (index: number, id: number, type: number, n: number) => {
    const at = indexIfd + 2 + index * 12;
    u16(id, at);
    u16(type, at + 2);
    u32(n, at + 4);
    return at + 8;
  };
  tiff.write('0100', tag(0, 0xb000, 7, 4), 'latin1');
  u32(count, tag(1, 0xb001, 4, 1));
  u32(entriesAt, tag(2, 0xb002, 7, count * 16));
  u32(uidsAt, tag(3, 0xb003, 7, count * 33));
  u32(attributeIfd, indexIfd + 2 + indexTags * 12);
  u16(1, attributeIfd);
  u16(0xb101, attributeIfd + 2);
  u16(4, attributeIfd + 4);
  u32(1, attributeIfd + 6);
  u32(1, attributeIfd + 10);
  entries.forEach((entry, index) => {
    const at = entriesAt + index * 16;
    u32(entry.attribute, at);
    u32(entry.size, at + 4);
    u32(entry.offset, at + 8);
    u16(index === 0 ? 2 : 0, at + 12);
    tiff.write(`SYNTH-SERIAL-0001-${index}`, uidsAt + index * 33, 'latin1');
  });
  return Buffer.concat([Buffer.from('MPF\0', 'latin1'), tiff]);
}

interface SecondaryImage {
  readonly bytes: Buffer;
  readonly attribute: number;
}

interface MpfAssembly {
  readonly header: readonly Buffer[];
  readonly base: Buffer;
  readonly primaryAttribute: number;
  readonly secondaries: readonly SecondaryImage[];
  readonly littleEndian: boolean;
  readonly trailer?: Buffer;
  /** Added to the first secondary image's offset to corrupt the index. */
  readonly offsetSkew?: number;
}

/** The primary image with an MPF APP2 after its header, then the secondaries. */
function assembleWithMpf(assembly: MpfAssembly): Buffer {
  const count = assembly.secondaries.length + 1;
  const placeholder = jpegSegment(
    0xe2,
    mpfPayload(
      Array.from({ length: count }, () => ({
        attribute: 0,
        size: 0,
        offset: 0
      })),
      assembly.littleEndian
    )
  );
  const header = Buffer.concat(assembly.header);
  const mpfAt = SOI.length + header.length;
  const primaryLength = mpfAt + placeholder.length + assembly.base.length - 2;
  const tiffStart = mpfAt + 8;
  let cursor = primaryLength;
  const entries: MpfFixtureEntry[] = [
    {
      attribute: assembly.primaryAttribute,
      size: primaryLength,
      offset: 0
    },
    ...assembly.secondaries.map((secondary, index) => {
      const entry = {
        attribute: secondary.attribute,
        size: secondary.bytes.length,
        offset:
          cursor - tiffStart + (index === 0 ? (assembly.offsetSkew ?? 0) : 0)
      };
      cursor += secondary.bytes.length;
      return entry;
    })
  ];
  return Buffer.concat([
    SOI,
    header,
    jpegSegment(0xe2, mpfPayload(entries, assembly.littleEndian)),
    assembly.base.subarray(2),
    ...assembly.secondaries.map((secondary) => secondary.bytes),
    assembly.trailer ?? Buffer.alloc(0)
  ]);
}

// ----- Fixtures ---------------------------------------------------------------

export interface HdrJpegFixture {
  readonly jpeg: Buffer;
  /** The embedded gain map image, identifying metadata included. */
  readonly gainMap: Buffer;
  /** Secondary images a strip must drop. */
  readonly dropped: readonly Buffer[];
  readonly thumbnail: Buffer;
}

export interface UltraHdrOptions {
  readonly offsetSkew?: number;
}

/**
 * P3 primary image with JFIF and EXIF thumbnails, full EXIF, mixed XMP, IPTC,
 * a comment and the ISO 21496-1 version block; a gain map with its own
 * thumbnails, EXIF, gain map XMP mixed with identifying values, ISO metadata
 * and a comment; a Depth container item; an MPF large thumbnail; a trailer.
 * The little-endian MPF index lists all four images and image UIDs.
 */
export async function identifyingUltraHdrJpeg(
  options: UltraHdrOptions = {}
): Promise<HdrJpegFixture> {
  const thumbnail = await syntheticThumbnail();
  const gainMap = withHeader(await jpegOf(16, 8, 1, 7), [
    jpegSegment(0xe0, jfifWithThumbnail()),
    exifSegment(thumbnail),
    xmpSegment(ULTRA_HDR_GAIN_MAP_XMP),
    isoSegment(isoGainMapMetadata()),
    comment('Gain map Jane Synthetic')
  ]);
  const depth = withHeader(await jpegOf(16, 8, 1, 29), [
    xmpSegment(DEPTH_XMP),
    comment('Depth owner@example.invalid')
  ]);
  const previewThumbnail = withHeader(await jpegOf(8, 4, 3, 13), [
    exifSegment()
  ]);
  const jpeg = assembleWithMpf({
    header: [
      jpegSegment(0xe0, jfifWithThumbnail()),
      exifSegment(thumbnail),
      xmpSegment(ultraHdrPrimaryXmp(gainMap.length, depth.length)),
      isoSegment(ISO_VERSION_ONLY),
      jpegSegment(0xed, iptcCityResource()),
      comment('Comment owner@example.invalid')
    ],
    base: await jpegOf(32, 16, 3, 3, true),
    primaryAttribute:
      MPF_DEPENDENT_PARENT | MPF_REPRESENTATIVE | MPF_PRIMARY_TYPE,
    secondaries: [
      { bytes: gainMap, attribute: MPF_UNDEFINED_TYPE },
      { bytes: depth, attribute: MPF_UNDEFINED_TYPE },
      { bytes: previewThumbnail, attribute: MPF_LARGE_THUMBNAIL_TYPE }
    ],
    littleEndian: true,
    trailer: Buffer.from('SEFT-synthetic-trailer', 'latin1'),
    offsetSkew: options.offsetSkew
  });
  return { jpeg, gainMap, dropped: [depth, previewThumbnail], thumbnail };
}

export interface AppleHdrOptions {
  /** Newer iOS also writes ISO 21496-1 metadata. */
  readonly iso?: boolean;
}

/**
 * Apple-style HDR JPEG: a primary image with EXIF (and thumbnail) and purely
 * identifying XMP, a big-endian MPF index, an HDR gain map auxiliary image
 * with identifying EXIF and XMP, and a portrait matte auxiliary image.
 */
export async function identifyingAppleHdrJpeg(
  options: AppleHdrOptions = {}
): Promise<HdrJpegFixture> {
  const thumbnail = await syntheticThumbnail();
  const gainMap = withHeader(await jpegOf(16, 8, 1, 11), [
    exifSegment(thumbnail),
    xmpSegment(APPLE_GAIN_MAP_XMP),
    ...(options.iso ? [isoSegment(isoGainMapMetadata())] : [])
  ]);
  const matte = withHeader(await jpegOf(16, 8, 1, 31), [
    xmpSegment(APPLE_MATTE_XMP)
  ]);
  const jpeg = assembleWithMpf({
    header: [
      exifSegment(thumbnail),
      xmpSegment(APPLE_PRIMARY_XMP),
      ...(options.iso ? [isoSegment(ISO_VERSION_ONLY)] : [])
    ],
    base: await jpegOf(32, 16, 3, 5, true),
    primaryAttribute: MPF_REPRESENTATIVE | MPF_PRIMARY_TYPE,
    secondaries: [
      { bytes: gainMap, attribute: MPF_UNDEFINED_TYPE },
      { bytes: matte, attribute: MPF_UNDEFINED_TYPE }
    ],
    littleEndian: false
  });
  return { jpeg, gainMap, dropped: [matte], thumbnail };
}
