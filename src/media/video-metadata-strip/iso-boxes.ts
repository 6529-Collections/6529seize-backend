import { FileHandle } from 'node:fs/promises';

/**
 * Why a video is not rewritten. Each is a structure the rewriter does not
 * claim to understand, so it refuses instead of guessing.
 */
export enum VideoStructureProblem {
  /** Not an ISO base media (MP4) or QuickTime file. */
  NOT_ISO_MEDIA = 'not_iso_media',
  MALFORMED = 'malformed',
  /** Fragmented MP4 (`moof`/`mvex`): samples live in movie fragments. */
  FRAGMENTED = 'fragmented',
  /** Old QuickTime compressed movie header (`cmov`). */
  COMPRESSED_MOVIE = 'compressed_movie',
  MOVIE_HEADER_TOO_LARGE = 'movie_header_too_large',
  NO_AUDIO_VIDEO_TRACKS = 'no_audio_video_tracks',
  /** Samples stored in another file. */
  EXTERNAL_DATA_REFERENCE = 'external_data_reference',
  /** Sample tables whose byte layout cannot be proven from sizes alone. */
  UNSUPPORTED_SAMPLE_TABLE = 'unsupported_sample_table',
  ENCRYPTED = 'encrypted'
}

export class UnsupportedVideoStructure extends Error {
  constructor(
    readonly problem: VideoStructureProblem,
    detail: string
  ) {
    super(`${problem}: ${detail}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'UnsupportedVideoStructure';
  }
}

export function malformed(detail: string): UnsupportedVideoStructure {
  return new UnsupportedVideoStructure(VideoStructureProblem.MALFORMED, detail);
}

/** A box (QuickTime atom) located in a buffer or a file. */
export interface Box {
  /** Four characters, read as Latin-1 (`©xyz` keeps its 0xA9 byte). */
  readonly type: string;
  /** Offset of the box's first byte. */
  readonly start: number;
  /** Offset of the payload, after size, type, 64-bit size and uuid. */
  readonly payloadStart: number;
  /** Offset just past the box. */
  readonly end: number;
}

/** Box types are opaque bytes; reports show them escaped. */
export function printableBoxType(type: string): string {
  return JSON.stringify(type);
}

interface RawHeader {
  readonly size: number;
  readonly type: string;
  readonly headerSize: number;
}

/** Decodes one header from at least 8 bytes (16 for a 64-bit size). */
function decodeHeader(bytes: Buffer, remaining: number): RawHeader {
  let size = bytes.readUInt32BE(0);
  const type = bytes.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (bytes.length < 16) throw malformed('truncated 64-bit box size');
    const high = bytes.readUInt32BE(8);
    const low = bytes.readUInt32BE(12);
    if (high > 0x1fffff) throw malformed('box size out of range');
    size = high * 0x100000000 + low;
    headerSize = 16;
  } else if (size === 0) {
    // Size 0 means the box runs to the end of its parent.
    size = remaining;
  }
  if (type === 'uuid') headerSize += 16;
  if (size < headerSize || size > remaining) {
    throw malformed(`box ${printableBoxType(type)} overruns its parent`);
  }
  return { size, type, headerSize };
}

/** True when what is left is a QuickTime zero terminator or zero padding. */
function isZeroTail(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

/** The child boxes stored in `buffer` between `start` and `end`. */
export function readBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset < end) {
    const remaining = end - offset;
    if (remaining < 8) {
      if (isZeroTail(buffer.subarray(offset, end))) break;
      throw malformed('trailing bytes after the last box');
    }
    const header = decodeHeader(
      buffer.subarray(offset, Math.min(end, offset + 16)),
      remaining
    );
    boxes.push({
      type: header.type,
      start: offset,
      payloadStart: offset + header.headerSize,
      end: offset + header.size
    });
    offset += header.size;
  }
  return boxes;
}

export function childBoxes(buffer: Buffer, parent: Box): Box[] {
  return readBoxes(buffer, parent.payloadStart, parent.end);
}

export function payloadOf(buffer: Buffer, box: Box): Buffer {
  return buffer.subarray(box.payloadStart, box.end);
}

/** At most this many top-level boxes are read before giving up. */
const MAX_TOP_LEVEL_BOXES = 4096;

/** Top-level boxes that mean the file is fragmented. */
const FRAGMENT_BOXES = new Set(['moof', 'mfra', 'sidx', 'ssix', 'styp']);

export interface TopLevelBoxes {
  readonly boxes: Box[];
  /**
   * Bytes after the last box that do not form a box (appended vendor data
   * or junk), only accepted once `moov` and `mdat` were read. They are
   * never copied.
   */
  readonly trailingBytes: number;
}

function hasMovieAndData(boxes: Box[]): boolean {
  const types = boxes.map((box) => box.type);
  return types.includes('moov') && types.includes('mdat');
}

/** Decodes a top-level header, or null for trailing data after the movie. */
function decodeTopLevelHeader(
  header: Buffer,
  remaining: number,
  boxes: Box[]
): RawHeader | null {
  try {
    if (remaining < 8) throw malformed('trailing bytes after the last box');
    return decodeHeader(header, remaining);
  } catch (error) {
    if (hasMovieAndData(boxes)) return null;
    throw error;
  }
}

/**
 * The top-level boxes of a file, read from their headers only. A fragmented
 * file is refused as soon as a fragment box appears.
 */
export async function readTopLevelBoxes(
  file: FileHandle,
  fileSize: number
): Promise<TopLevelBoxes> {
  const boxes: Box[] = [];
  const header = Buffer.alloc(32);
  let offset = 0;
  while (offset < fileSize) {
    const remaining = fileSize - offset;
    const length = Math.min(header.length, remaining);
    const { bytesRead } = await file.read(header, 0, length, offset);
    if (bytesRead !== length) throw malformed('short read of a box header');
    if (remaining < 8 && isZeroTail(header.subarray(0, remaining))) break;
    const decoded = decodeTopLevelHeader(
      header.subarray(0, length),
      remaining,
      boxes
    );
    if (!decoded) return { boxes, trailingBytes: remaining };
    if (FRAGMENT_BOXES.has(decoded.type)) {
      throw new UnsupportedVideoStructure(
        VideoStructureProblem.FRAGMENTED,
        `top-level ${decoded.type}`
      );
    }
    boxes.push({
      type: decoded.type,
      start: offset,
      payloadStart: offset + decoded.headerSize,
      end: offset + decoded.size
    });
    if (boxes.length > MAX_TOP_LEVEL_BOXES) {
      throw malformed('too many top-level boxes');
    }
    offset += decoded.size;
  }
  return { boxes, trailingBytes: 0 };
}

/** Reads exactly `length` bytes at `position`. */
export async function readExactly(
  file: FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(
      bytes,
      done,
      length - done,
      position + done
    );
    if (bytesRead === 0) throw malformed('unexpected end of file');
    done += bytesRead;
  }
  return bytes;
}

/** A box with a standard 32-bit header around the given payload parts. */
export function buildBox(type: string, parts: readonly Buffer[]): Buffer {
  const payloadSize = parts.reduce((total, part) => total + part.length, 0);
  const size = 8 + payloadSize;
  if (size > 0xffffffff) throw malformed(`rebuilt ${type} is too large`);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, ...parts], size);
}

/**
 * A child box copied byte for byte, re-framed with a 32-bit header when it
 * used a 64-bit or to-the-end size, which would be wrong in a new parent.
 */
export function copyBox(buffer: Buffer, box: Box): Buffer {
  if (box.payloadStart - box.start === 8) {
    return buffer.subarray(box.start, box.end);
  }
  return buildBox(box.type, [payloadOf(buffer, box)]);
}

/**
 * End of the creation and modification times in an `mvhd`, `tkhd` or `mdhd`
 * payload: 32-bit times after version/flags in version 0, 64-bit in 1.
 */
export function timeFieldsEnd(payload: Buffer, type: string): number {
  const end = payload[0] === 1 ? 20 : 12;
  if (payload.length < end) throw malformed(`${type} is truncated`);
  return end;
}

/** The payload with its creation and modification times set to zero. */
export function payloadWithoutTimes(buffer: Buffer, box: Box): Buffer {
  const payload = Buffer.from(payloadOf(buffer, box));
  payload.fill(0, 4, timeFieldsEnd(payload, box.type));
  return payload;
}
