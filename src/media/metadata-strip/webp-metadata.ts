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

const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;
const VP8X_PAYLOAD_BYTES = 10;

/** Image data, alpha, colour profile and animation chunks; ANMF frames nest their own. */
const RENDER_CHUNKS: ReadonlySet<string> = new Set([
  'VP8 ',
  'VP8L',
  'ALPH',
  'ICCP',
  'ANIM',
  'ANMF'
]);

interface WebpChunk {
  readonly fourcc: string;
  readonly start: number;
  readonly dataStart: number;
  readonly dataEnd: number;
  readonly end: number;
}

interface WebpLayout {
  readonly chunks: readonly WebpChunk[];
  readonly trailingBytes: number;
  /** VP8X flags, or null for a simple (VP8/VP8L-only) file. */
  readonly flags: number | null;
}

function walkWebp(input: Buffer): WebpLayout {
  if (
    input.length < 12 ||
    input.toString('latin1', 0, 4) !== 'RIFF' ||
    input.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    throw new LosslessStripUnsupported('Not a WebP');
  }
  const riffEnd = 8 + input.readUInt32LE(4);
  assertWithin(input, riffEnd, 'WebP RIFF container');
  const chunks: WebpChunk[] = [];
  let position = 12;
  while (position < riffEnd) {
    if (position + 8 > riffEnd) {
      throw new LosslessStripUnsupported('Truncated WebP chunk header');
    }
    const fourcc = input.toString('latin1', position, position + 4);
    const size = input.readUInt32LE(position + 4);
    const dataStart = position + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffEnd) {
      throw new LosslessStripUnsupported('Truncated WebP chunk');
    }
    // Tolerate a missing pad byte after an odd-sized final chunk.
    const end = Math.min(dataEnd + (size & 1), riffEnd);
    chunks.push({ fourcc, start: position, dataStart, dataEnd, end });
    position = end;
  }
  const first = chunks[0];
  if (!first) throw new LosslessStripUnsupported('Empty WebP');
  let flags: number | null = null;
  if (first.fourcc === 'VP8X') {
    if (first.dataEnd - first.dataStart < VP8X_PAYLOAD_BYTES) {
      throw new LosslessStripUnsupported('Truncated VP8X chunk');
    }
    flags = input[first.dataStart];
  }
  return { chunks, trailingBytes: input.length - riffEnd, flags };
}

/** Header and payload, re-padded to an even length so later chunks stay aligned. */
function paddedChunk(input: Buffer, chunk: WebpChunk): Buffer {
  const bytes = input.subarray(chunk.start, chunk.dataEnd);
  return (chunk.dataEnd - chunk.dataStart) % 2 === 0
    ? bytes
    : Buffer.concat([bytes, Buffer.alloc(1)]);
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  const padding = Buffer.alloc(data.length % 2);
  return Buffer.concat([header, data, padding]);
}

/** EXIF orientation only applies to an extended file that flags its EXIF chunk. */
function signalledExif(layout: WebpLayout, chunk: WebpChunk): boolean {
  return (
    chunk.fourcc === 'EXIF' &&
    layout.flags !== null &&
    (layout.flags & VP8X_EXIF_FLAG) !== 0
  );
}

function chunkTiff(input: Buffer, chunk: WebpChunk): Buffer {
  return withoutExifHeader(input.subarray(chunk.dataStart, chunk.dataEnd));
}

function strip(input: Buffer): Buffer {
  const layout = walkWebp(input);
  const parts: Buffer[] = [];
  let exifSeen = false;
  let exifWritten = false;
  let vp8x: Buffer | null = null;
  for (let index = 0; index < layout.chunks.length; index++) {
    const chunk = layout.chunks[index];
    if (index === 0 && layout.flags !== null) {
      vp8x = Buffer.from(input.subarray(chunk.dataStart, chunk.dataEnd));
      parts.push(Buffer.alloc(0));
    } else if (RENDER_CHUNKS.has(chunk.fourcc)) {
      parts.push(paddedChunk(input, chunk));
    } else if (signalledExif(layout, chunk) && !exifSeen) {
      exifSeen = true;
      const orientation = readTiffOrientation(chunkTiff(input, chunk));
      if (orientation !== 1) {
        exifWritten = true;
        parts.push(webpChunk('EXIF', minimalOrientationTiff(orientation)));
      }
    }
  }
  if (vp8x) {
    vp8x[0] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
    if (exifWritten) vp8x[0] |= VP8X_EXIF_FLAG;
    parts[0] = webpChunk('VP8X', vp8x);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

function u24(input: Buffer, offset: number): number {
  return input.readUIntLE(offset, 3);
}

function imageSize(
  input: Buffer,
  chunk: WebpChunk
): { width: number; height: number } {
  const data = input.subarray(chunk.dataStart, chunk.dataEnd);
  if (chunk.fourcc === 'VP8X') {
    return { width: u24(data, 4) + 1, height: u24(data, 7) + 1 };
  }
  if (chunk.fourcc === 'VP8 ' && data.length >= 10) {
    return {
      width: data.readUInt16LE(6) & 0x3fff,
      height: data.readUInt16LE(8) & 0x3fff
    };
  }
  if (chunk.fourcc === 'VP8L' && data.length >= 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  throw new LosslessStripUnsupported('WebP has no readable image header');
}

function describe(input: Buffer): ContainerDescription {
  const layout = walkWebp(input);
  const metadataBlocks: string[] = [];
  let orientation: number | undefined;
  const hash = newRenderHash();
  for (let index = 0; index < layout.chunks.length; index++) {
    const chunk = layout.chunks[index];
    if (index === 0 && layout.flags !== null) {
      const vp8x = Buffer.from(input.subarray(chunk.dataStart, chunk.dataEnd));
      vp8x[0] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      hash.update(vp8x);
    } else if (RENDER_CHUNKS.has(chunk.fourcc)) {
      hash.update(input.subarray(chunk.start, chunk.dataEnd));
    } else if (signalledExif(layout, chunk)) {
      const tiff = chunkTiff(input, chunk);
      orientation ??= readTiffOrientation(tiff);
      if (!isOrientationOnlyTiff(tiff)) metadataBlocks.push('EXIF');
    } else {
      metadataBlocks.push(chunk.fourcc.trim() || 'unknown-chunk');
    }
  }
  if (layout.trailingBytes > 0) metadataBlocks.push('trailing-data');
  return {
    ...imageSize(input, layout.chunks[0]),
    orientation: orientation ?? 1,
    renderDigest: hash.digest('hex'),
    metadataBlocks
  };
}

export const webpMetadataStripper: FormatMetadataStripper = {
  strip,
  describe
};
