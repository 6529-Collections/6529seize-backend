import { Readable, Transform } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { ARTWORK_FORMATS } from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  AssetInspectionError,
  hashAssetStream,
  inspectAssetHeader
} from '@/artwork-documentation/assets/artwork-assets.inspection';
import {
  MAX_PDF_BYTES,
  validatePdfContent
} from '@/attachments/pdf-content-validator';
import { AssetTechnicalMetadata } from '@/artwork-documentation/assets/artwork-assets.types';

export const ARTWORK_ARCHIVE_POLICY = Object.freeze({
  max_entries: 2000,
  max_directory_bytes: 8 * 1024 ** 2,
  max_expanded_bytes: 4 * 1024 ** 3,
  max_compression_ratio: 100,
  max_path_bytes: 512,
  max_depth: 1
});
export type ArchiveRangeReader = (
  start: number,
  length: number
) => Promise<Buffer>;
export type ArchiveRangeStream = (
  start: number,
  length: number
) => Promise<Readable>;
type Entry = {
  path: string;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  directory: boolean;
};

function reject(code: string): never {
  throw new AssetInspectionError(code);
}

function safePath(bytes: Buffer, seen: Set<string>): string {
  let path: string;
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return reject('ARCHIVE_INVALID_PATH_ENCODING');
  }
  if (
    bytes.length > ARTWORK_ARCHIVE_POLICY.max_path_bytes ||
    !path ||
    /[\\:]/.test(path) ||
    Array.from(path).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    path.startsWith('/')
  )
    reject('ARCHIVE_UNSAFE_PATH');
  const segments = path.replace(/\/$/, '').split('/');
  if (
    segments.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[ .]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
    reject('ARCHIVE_UNSAFE_PATH');
  const key = path.normalize('NFC').toLowerCase().replace(/\/$/, '');
  if (seen.has(key)) reject('ARCHIVE_DUPLICATE_PATH');
  seen.add(key);
  return path;
}

function parseDirectoryEntry(
  bytes: Buffer,
  offset: number,
  seen: Set<string>
): { entry: Entry; next: number } {
  if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
    reject('ARCHIVE_INVALID_DIRECTORY');
  const nameLength = bytes.readUInt16LE(offset + 28);
  const next =
    offset +
    46 +
    nameLength +
    bytes.readUInt16LE(offset + 30) +
    bytes.readUInt16LE(offset + 32);
  if (next > bytes.length || bytes.readUInt16LE(offset + 34) !== 0)
    reject('ARCHIVE_INVALID_DIRECTORY');
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  if (flags & 0x2041) reject('ARCHIVE_ENCRYPTED');
  if (![0, 8].includes(method)) reject('ARCHIVE_UNSUPPORTED_COMPRESSION');
  const mode = bytes.readUInt32LE(offset + 38) >>> 16;
  if (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000))
    reject('ARCHIVE_LINK_NOT_ALLOWED');
  const path = safePath(
    bytes.subarray(offset + 46, offset + 46 + nameLength),
    seen
  );
  const size = bytes.readUInt32LE(offset + 24);
  const compressed = bytes.readUInt32LE(offset + 20);
  const fileOffset = bytes.readUInt32LE(offset + 42);
  if ([size, compressed, fileOffset].includes(0xffffffff))
    reject('ARCHIVE_ZIP64_UNSUPPORTED');
  if (
    size >
    Math.max(compressed, 1) * ARTWORK_ARCHIVE_POLICY.max_compression_ratio
  )
    reject('ARCHIVE_EXPANSION_LIMIT');
  return {
    entry: {
      path,
      flags,
      method,
      crc: bytes.readUInt32LE(offset + 16),
      compressed,
      size,
      offset: fileOffset,
      directory: path.endsWith('/')
    },
    next
  };
}

function validatePathConflicts(entries: Entry[]): void {
  const files = new Set(
    entries
      .filter((entry) => !entry.directory)
      .map((entry) => entry.path.normalize('NFC').toLowerCase())
  );
  for (const entry of entries) {
    const parts = entry.path.normalize('NFC').toLowerCase().split('/');
    for (let index = 1; index < parts.length; index++) {
      if (files.has(parts.slice(0, index).join('/')))
        reject('ARCHIVE_PATH_CONFLICT');
    }
  }
}

function parseDirectory(bytes: Buffer, count: number): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const parsed = parseDirectoryEntry(bytes, offset, seen);
    entries.push(parsed.entry);
    offset = parsed.next;
  }
  if (offset !== bytes.length) reject('ARCHIVE_INVALID_DIRECTORY');
  validatePathConflicts(entries);
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

async function inspectEntry(
  stream: Readable,
  entry: Entry,
  signal: AbortSignal
): Promise<string> {
  const extension = entry.path.split('.').pop()?.toLowerCase() ?? '';
  const pdfChunks: Buffer[] = [];
  if (extension === 'pdf' && entry.size > MAX_PDF_BYTES)
    reject('PDF_SIZE_LIMIT');
  let crc = 0xffffffff;
  let count = 0;
  const inspected = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > entry.size) {
        callback(new AssetInspectionError('ARCHIVE_EXPANSION_LIMIT'));
        return;
      }
      for (let index = 0; index < chunk.length; index++)
        crc = CRC_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8);
      if (extension === 'pdf') pdfChunks.push(chunk);
      callback(null, chunk);
    }
  });
  const inflater = entry.method === 8 ? createInflateRaw() : null;
  // Upstream errors must reach the consumer and every stream must close on rejection.
  stream.on('error', (error) => inspected.destroy(error));
  if (inflater)
    inflater.on('error', () =>
      inspected.destroy(
        new AssetInspectionError('ARCHIVE_INVALID_COMPRESSED_DATA')
      )
    );
  (inflater ? stream.pipe(inflater) : stream).pipe(inspected);
  try {
    const result = await hashAssetStream(
      inspected,
      entry.size,
      extension,
      signal
    );
    if ((crc ^ 0xffffffff) >>> 0 !== entry.crc) reject('ARCHIVE_CRC_MISMATCH');
    // Nested/compressed containers remain explicit unsupported states, never silently skipped.
    if (
      /^(?:zip|epub|rar|7z|gz|tgz|tar|bz2|xz)$/i.test(extension) ||
      result.prefix.subarray(0, 2).equals(Buffer.from('PK')) ||
      result.prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
      result.prefix.subarray(0, 4).toString('ascii') === 'Rar!' ||
      result.prefix
        .subarray(0, 6)
        .equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
      result.prefix.subarray(0, 3).toString('ascii') === 'BZh' ||
      result.prefix
        .subarray(0, 6)
        .equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])) ||
      result.prefix.subarray(257, 262).toString('ascii') === 'ustar'
    )
      reject('ARCHIVE_NESTING_UNSUPPORTED');
    if (ARTWORK_FORMATS[extension])
      inspectAssetHeader(result.prefix, extension);
    if (extension === 'pdf') await validatePdfContent(Buffer.concat(pdfChunks));
    return result.sha256;
  } finally {
    stream.destroy();
    inflater?.destroy();
    inspected.destroy();
  }
}

async function readDirectory(
  size: number,
  read: ArchiveRangeReader
): Promise<{ entries: Entry[]; directoryOffset: number }> {
  const tailLength = Math.min(size, 65557);
  const tail = await read(size - tailLength, tailLength);
  let end = -1;
  for (let pos = tail.length - 22; pos >= 0; pos--) {
    if (
      tail.readUInt32LE(pos) === 0x06054b50 &&
      pos + 22 + tail.readUInt16LE(pos + 20) === tail.length
    ) {
      end = pos;
      break;
    }
  }
  if (end < 0) reject('ARCHIVE_INVALID_DIRECTORY');
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (
    tail.readUInt16LE(end + 4) ||
    tail.readUInt16LE(end + 6) ||
    count !== tail.readUInt16LE(end + 8)
  )
    reject('ARCHIVE_MULTIPART_UNSUPPORTED');
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    reject('ARCHIVE_ZIP64_UNSUPPORTED');
  if (
    !count ||
    count > ARTWORK_ARCHIVE_POLICY.max_entries ||
    directorySize > ARTWORK_ARCHIVE_POLICY.max_directory_bytes
  )
    reject('ARCHIVE_ENTRY_LIMIT');
  if (directoryOffset + directorySize !== size - tailLength + end)
    reject('ARCHIVE_INVALID_DIRECTORY');
  const entries = parseDirectory(
    await read(directoryOffset, directorySize),
    count
  );
  return { entries, directoryOffset };
}

async function validateLocalEntry(
  entry: Entry,
  priorEnd: number,
  directoryOffset: number,
  read: ArchiveRangeReader
): Promise<number> {
  if (entry.offset < priorEnd || entry.offset + 30 > directoryOffset)
    reject('ARCHIVE_OVERLAPPING_ENTRY');
  const local = await read(entry.offset, 30);
  if (
    local.readUInt32LE(0) !== 0x04034b50 ||
    local.readUInt16LE(6) !== entry.flags ||
    local.readUInt16LE(8) !== entry.method
  )
    reject('ARCHIVE_LOCAL_HEADER_MISMATCH');
  if (
    !(entry.flags & 8) &&
    (local.readUInt32LE(14) !== entry.crc ||
      local.readUInt32LE(18) !== entry.compressed ||
      local.readUInt32LE(22) !== entry.size)
  )
    reject('ARCHIVE_LOCAL_HEADER_MISMATCH');
  const nameLength = local.readUInt16LE(26);
  const dataStart = entry.offset + 30 + nameLength + local.readUInt16LE(28);
  if (dataStart + entry.compressed > directoryOffset)
    reject('ARCHIVE_OVERLAPPING_ENTRY');
  if (
    !(await read(entry.offset + 30, nameLength)).equals(
      Buffer.from(entry.path, 'utf8')
    )
  )
    reject('ARCHIVE_LOCAL_HEADER_MISMATCH');
  return dataStart;
}

/** Inspect a ZIP without extracting paths or executing members. Original and members remain inert. */
export async function inspectArtworkArchive(
  size: number,
  read: ArchiveRangeReader,
  stream: ArchiveRangeStream,
  signal: AbortSignal
): Promise<NonNullable<AssetTechnicalMetadata['archive']>> {
  const { entries, directoryOffset } = await readDirectory(size, read);
  const expanded = entries.reduce((total, entry) => total + entry.size, 0);
  if (expanded > ARTWORK_ARCHIVE_POLICY.max_expanded_bytes)
    reject('ARCHIVE_EXPANSION_LIMIT');
  const inventory: NonNullable<AssetTechnicalMetadata['archive']>['inventory'] =
    [];
  let priorEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (signal.aborted) throw new Error('Archive inspection aborted');
    const dataStart = await validateLocalEntry(
      entry,
      priorEnd,
      directoryOffset,
      read
    );
    priorEnd = dataStart + entry.compressed;
    if (entry.directory) {
      if (entry.size || entry.compressed) reject('ARCHIVE_INVALID_DIRECTORY');
      continue;
    }
    const source = entry.compressed
      ? await stream(dataStart, entry.compressed)
      : Readable.from([]);
    const sha256 = await inspectEntry(source, entry, signal);
    inventory.push({ path: entry.path, size_bytes: entry.size, sha256 });
  }
  return { entries: inventory.length, expanded_bytes: expanded, inventory };
}
