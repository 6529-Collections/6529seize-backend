import {
  isOrientationOnlyTiff,
  minimalOrientationTiff,
  readTiffOrientation,
  withoutExifHeader
} from './exif-orientation';
import {
  assertWithin,
  ContainerDescription,
  FormatMetadataStripper,
  LosslessStripUnsupported,
  newRenderHash
} from './metadata-strip.types';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * Chunks a decoder needs for pixels, transparency, colour and animation.
 * Every other ancillary chunk (tEXt, zTXt, iTXt, tIME, dSIG, Apple's iDOT,
 * private chunks, ...) is dropped; eXIf is reduced to Orientation.
 */
const RENDER_CHUNKS: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'mDCv',
  'cLLi',
  'bKGD',
  'hIST',
  'pHYs',
  'acTL',
  'fcTL',
  'fdAT'
]);

interface PngChunk {
  readonly type: string;
  readonly start: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly end: number;
}

interface PngLayout {
  readonly chunks: readonly PngChunk[];
  readonly trailingBytes: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function walkPng(input: Buffer): PngLayout {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new LosslessStripUnsupported('Not a PNG');
  }
  const chunks: PngChunk[] = [];
  let position = 8;
  for (;;) {
    assertWithin(input, position + 8, 'PNG chunk');
    const length = input.readUInt32BE(position);
    const type = input.toString('latin1', position + 4, position + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new LosslessStripUnsupported('Invalid PNG chunk type');
    }
    const dataStart = position + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    assertWithin(input, end, 'PNG chunk');
    chunks.push({ type, start: position, dataStart, dataEnd, end });
    if (type === 'IEND') return { chunks, trailingBytes: input.length - end };
    position = end;
  }
}

type ChunkRole = 'render' | 'exif' | 'drop';

function chunkRole(type: string): ChunkRole {
  if (RENDER_CHUNKS.has(type)) return 'render';
  if (type === 'eXIf') return 'exif';
  // An unknown critical chunk (upper-case first letter) cannot be dropped.
  if (type[0] === type[0].toUpperCase()) {
    throw new LosslessStripUnsupported(`Unknown critical PNG chunk ${type}`);
  }
  return 'drop';
}

function chunkTiff(input: Buffer, chunk: PngChunk): Buffer {
  return withoutExifHeader(input.subarray(chunk.dataStart, chunk.dataEnd));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function strip(input: Buffer): Buffer {
  const { chunks } = walkPng(input);
  const parts: Buffer[] = [PNG_SIGNATURE];
  let exifSeen = false;
  for (const chunk of chunks) {
    const role = chunkRole(chunk.type);
    if (role === 'render') {
      parts.push(input.subarray(chunk.start, chunk.end));
    } else if (role === 'exif' && !exifSeen) {
      exifSeen = true;
      const orientation = readTiffOrientation(chunkTiff(input, chunk));
      if (orientation !== 1) {
        parts.push(pngChunk('eXIf', minimalOrientationTiff(orientation)));
      }
    }
  }
  return Buffer.concat(parts);
}

function describe(input: Buffer): ContainerDescription {
  const { chunks, trailingBytes } = walkPng(input);
  const header = chunks[0];
  if (header?.type !== 'IHDR' || header.dataEnd - header.dataStart < 13) {
    throw new LosslessStripUnsupported('PNG does not start with IHDR');
  }
  const metadataBlocks: string[] = [];
  let orientation: number | undefined;
  const hash = newRenderHash();
  for (const chunk of chunks) {
    const role = chunkRole(chunk.type);
    if (role === 'render') {
      hash.update(input.subarray(chunk.start, chunk.end));
    } else if (role === 'exif') {
      const tiff = chunkTiff(input, chunk);
      orientation ??= readTiffOrientation(tiff);
      if (!isOrientationOnlyTiff(tiff)) metadataBlocks.push('eXIf');
    } else {
      metadataBlocks.push(chunk.type);
    }
  }
  if (trailingBytes > 0) metadataBlocks.push('trailing-data');
  return {
    width: input.readUInt32BE(header.dataStart),
    height: input.readUInt32BE(header.dataStart + 4),
    orientation: orientation ?? 1,
    renderDigest: hash.digest('hex'),
    metadataBlocks
  };
}

export const pngMetadataStripper: FormatMetadataStripper = { strip, describe };
