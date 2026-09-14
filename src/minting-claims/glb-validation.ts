import { BadRequestException } from '@/exceptions';
import { TextDecoder } from 'node:util';

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function invalidGlb(reason: string): never {
  throw new BadRequestException(`Invalid GLB: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonChunk(data: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return invalidGlb('JSON chunk must contain valid UTF-8 JSON');
  }
  if (!isObject(parsed) || !isObject(parsed.asset)) {
    return invalidGlb('JSON chunk must contain a glTF asset object');
  }
  const { version, minVersion } = parsed.asset;
  if (
    typeof version !== 'string' ||
    !/^2\.\d+$/.test(version) ||
    (minVersion !== undefined && minVersion !== '2.0')
  ) {
    return invalidGlb('unsupported glTF asset version');
  }
  return parsed;
}

function validateEmbeddedBuffer(
  json: Record<string, unknown>,
  binary: Buffer | null
): void {
  if (json.buffers === undefined) return;
  if (!Array.isArray(json.buffers) || json.buffers.length === 0) {
    return invalidGlb('buffers must be a non-empty array');
  }
  const first: unknown = json.buffers[0];
  if (!isObject(first)) return invalidGlb('buffer must be an object');
  // External resources remain permitted by glTF; validation never fetches them.
  if (first.uri !== undefined) return;
  const length = first.byteLength;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length <= 0
  ) {
    return invalidGlb('embedded buffer byteLength must be positive');
  }
  if (binary === null || binary.length < length || binary.length - length > 3) {
    return invalidGlb(
      'BIN chunk does not match the embedded buffer byteLength'
    );
  }
  if (binary.subarray(length).some((byte) => byte !== 0)) {
    invalidGlb('BIN chunk padding must contain zero bytes');
  }
}

function validateHeader(buffer: Buffer): void {
  if (buffer.length < HEADER_BYTES + CHUNK_HEADER_BYTES) {
    return invalidGlb('missing header or JSON chunk');
  }
  if (buffer.readUInt32LE(0) !== 0x46546c67) {
    return invalidGlb('incorrect magic bytes');
  }
  if (buffer.readUInt32LE(4) !== 2) {
    return invalidGlb('unsupported container version');
  }
  if (buffer.readUInt32LE(8) !== buffer.length) {
    return invalidGlb('declared length does not match the file');
  }
}

function readChunk(buffer: Buffer, offset: number) {
  if (buffer.length - offset < CHUNK_HEADER_BYTES) {
    return invalidGlb('truncated chunk header');
  }
  const length = buffer.readUInt32LE(offset);
  const type = buffer.readUInt32LE(offset + 4);
  const start = offset + CHUNK_HEADER_BYTES;
  const end = start + length;
  if (length % 4 !== 0 || end > buffer.length) {
    return invalidGlb('unaligned or truncated chunk');
  }
  return { type, start, end };
}

/** Validate the GLB container, not scene semantics or external dependencies.
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
 */
export function assertValidGlb(buffer: Buffer): void {
  validateHeader(buffer);
  let offset = HEADER_BYTES;
  let chunkIndex = 0;
  let json: Record<string, unknown> | null = null;
  let binary: Buffer | null = null;
  while (offset < buffer.length) {
    const { type, start, end } = readChunk(buffer, offset);
    if (chunkIndex === 0 && type !== JSON_CHUNK) {
      return invalidGlb('first chunk must be JSON');
    }
    if (type === JSON_CHUNK) {
      if (chunkIndex !== 0) return invalidGlb('duplicate JSON chunk');
      json = readJsonChunk(buffer.subarray(start, end));
    } else if (type === BIN_CHUNK) {
      if (chunkIndex !== 1) return invalidGlb('BIN must be the second chunk');
      binary = buffer.subarray(start, end);
    }
    // Unknown chunk types are ignored for forward compatibility, per glTF 2.0.
    offset = end;
    chunkIndex++;
  }
  if (json === null) return invalidGlb('missing JSON chunk');
  validateEmbeddedBuffer(json, binary);
}
