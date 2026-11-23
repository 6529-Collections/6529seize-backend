import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';

/**
 * Record content: what one orderer record changes in the delivery
 * service's tables, as row operations, plus the record's place in
 * its stream: `pos`, and `prev`, the content hash of the record before it.
 *
 * Byte layout (content format tag 0x10 of the signed records API):
 *
 *   0x10 | version u8 (1) | header length u32be | header | inline bins
 *
 * The header is canonical JSON `{"bins":[...],"ops":[...],"pos","prev",
 * "type","v":1}`. Byte values in rows are `{"$b": i}`, an index into the
 * bins, so ciphertext is carried raw and only once. A bin is inline (its
 * length) or external (`{"h": sha256, "n": length}`). External bytes travel
 * as their own relay payload, so the relays can drop them at the end of
 * their retention while the record, and the hash chain through it, stays.
 */
export const E2EE_RECORD_CONTAINER_TAG = 0x10;
const CONTAINER_VERSION = 1;
const PREFIX_BYTES = 6;

/** Bytes carried outside the container, as a relay payload. */
export class E2eeExternalBytes {
  constructor(readonly bytes: Buffer) {}
}

/** External bytes a reader could not get (the relays dropped them). */
export class E2eeMissingBytes {
  constructor(
    readonly sha256: string,
    readonly length: number
  ) {}
}

/** A column value in a row operation. */
export type E2eeRowValue =
  | string
  | number
  | boolean
  | null
  | Buffer
  | E2eeExternalBytes
  | E2eeMissingBytes;

export type E2eeRow = Readonly<Record<string, E2eeRowValue>>;

export type E2eeRowOp =
  | { readonly op: 'put'; readonly table: string; readonly row: E2eeRow }
  | { readonly op: 'del'; readonly table: string; readonly key: E2eeRow };

export interface E2eeRecordContent {
  /** What the record is, e.g. `message`, `genesis`, `welcome`. */
  readonly type: string;
  /** 1-based position in its stream. */
  readonly pos: number;
  /** The content hash of the stream's previous record; null at pos 1. */
  readonly prev: string | null;
  readonly ops: readonly E2eeRowOp[];
}

/** Decoded content, with the external bytes it names. */
export interface E2eeDecodedRecordContent extends E2eeRecordContent {
  readonly external: readonly {
    readonly sha256: string;
    readonly length: number;
  }[];
}

/** The encoded content, and the bytes that travel as payloads. */
export interface E2eeEncodedRecordContent {
  readonly content: Buffer;
  readonly external: readonly Buffer[];
}

type WireValue = string | number | boolean | null | { readonly $b: number };
type WireBin = number | { readonly h: string; readonly n: number };

interface WireOp {
  readonly op: 'put' | 'del';
  readonly table: string;
  readonly row: Record<string, WireValue>;
}

interface WireHeader {
  readonly v: number;
  readonly type: string;
  readonly pos: number;
  readonly prev: string | null;
  readonly ops: readonly WireOp[];
  readonly bins: readonly WireBin[];
}

export class E2eeRecordContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeRecordContainerError';
    Object.setPrototypeOf(this, E2eeRecordContainerError.prototype);
  }
}

export function e2eeSha256(bytes: Buffer): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

interface Bins {
  readonly wire: WireBin[];
  readonly inline: Buffer[];
  readonly external: Buffer[];
}

function toWireRow(row: E2eeRow, bins: Bins): Record<string, WireValue> {
  const wire: Record<string, WireValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) {
      wire[column] = { $b: bins.wire.length };
      bins.wire.push(value.length);
      bins.inline.push(value);
    } else if (value instanceof E2eeExternalBytes) {
      wire[column] = { $b: bins.wire.length };
      bins.wire.push({ h: e2eeSha256(value.bytes), n: value.bytes.length });
      bins.external.push(value.bytes);
    } else if (value instanceof E2eeMissingBytes) {
      throw new E2eeRecordContainerError(`Column ${column} has no bytes`);
    } else {
      wire[column] = value;
    }
  }
  return wire;
}

export function encodeE2eeRecordContent(
  content: E2eeRecordContent
): E2eeEncodedRecordContent {
  const bins: Bins = { wire: [], inline: [], external: [] };
  const ops: WireOp[] = content.ops.map((op) => ({
    op: op.op,
    table: op.table,
    row: toWireRow(op.op === 'put' ? op.row : op.key, bins)
  }));
  const header: WireHeader = {
    v: CONTAINER_VERSION,
    type: content.type,
    pos: content.pos,
    prev: content.prev,
    ops,
    bins: bins.wire
  };
  const headerBytes = Buffer.from(canonicalizeJson(header), 'utf8');
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.writeUInt8(E2EE_RECORD_CONTAINER_TAG, 0);
  prefix.writeUInt8(CONTAINER_VERSION, 1);
  prefix.writeUInt32BE(headerBytes.length, 2);
  return {
    content: Buffer.concat([prefix, headerBytes, ...bins.inline]),
    external: bins.external
  };
}

function isWireBin(value: unknown): value is { $b: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { $b?: unknown }).$b === 'number'
  );
}

function fromWireRow(
  row: Record<string, unknown>,
  bins: readonly (Buffer | E2eeMissingBytes)[]
): E2eeRow {
  const decoded: Record<string, E2eeRowValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (isWireBin(value)) {
      const bin = bins[value.$b];
      if (!bin) throw new E2eeRecordContainerError(`No bin ${value.$b}`);
      decoded[column] = bin;
    } else if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      decoded[column] = value;
    } else {
      throw new E2eeRecordContainerError(`Bad value in column ${column}`);
    }
  }
  return decoded;
}

function parseHeader(bytes: Buffer): WireHeader {
  let header: WireHeader;
  try {
    header = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new E2eeRecordContainerError('Header is not JSON');
  }
  if (
    header?.v !== CONTAINER_VERSION ||
    typeof header.type !== 'string' ||
    !Number.isSafeInteger(header.pos) ||
    header.pos < 1 ||
    !(header.prev === null || typeof header.prev === 'string') ||
    !Array.isArray(header.ops) ||
    !Array.isArray(header.bins)
  ) {
    throw new E2eeRecordContainerError('Bad header');
  }
  return header;
}

function decodeBins(
  header: WireHeader,
  bytes: Buffer,
  headerEnd: number,
  external: (sha256: string) => Buffer | null
) {
  const bins: (Buffer | E2eeMissingBytes)[] = [];
  const named: { sha256: string; length: number }[] = [];
  let offset = headerEnd;
  for (const bin of header.bins) {
    if (typeof bin === 'object' && bin !== null) {
      if (!/^0x[0-9a-f]{64}$/.test(bin.h) || !Number.isSafeInteger(bin.n)) {
        throw new E2eeRecordContainerError('Bad external bin');
      }
      named.push({ sha256: bin.h, length: bin.n });
      const found = external(bin.h);
      bins.push(
        found?.length === bin.n && e2eeSha256(found) === bin.h
          ? found
          : new E2eeMissingBytes(bin.h, bin.n)
      );
      continue;
    }
    if (!Number.isSafeInteger(bin) || bin < 0) {
      throw new E2eeRecordContainerError('Bad bin length');
    }
    if (offset + bin > bytes.length) {
      throw new E2eeRecordContainerError('Bin overruns the container');
    }
    bins.push(Buffer.from(bytes.subarray(offset, offset + bin)));
    offset += bin;
  }
  if (offset !== bytes.length) {
    throw new E2eeRecordContainerError('Trailing bytes');
  }
  return { bins, named };
}

/**
 * Decodes content. `external` returns the bytes of an external bin by its
 * sha256, or null when they are gone; those decode as E2eeMissingBytes.
 */
export function decodeE2eeRecordContent(
  bytes: Buffer,
  external: (sha256: string) => Buffer | null = () => null
): E2eeDecodedRecordContent {
  if (bytes.length < PREFIX_BYTES) {
    throw new E2eeRecordContainerError('Too short');
  }
  if (bytes.readUInt8(0) !== E2EE_RECORD_CONTAINER_TAG) {
    throw new E2eeRecordContainerError('Not an e2ee record container');
  }
  if (bytes.readUInt8(1) !== CONTAINER_VERSION) {
    throw new E2eeRecordContainerError('Unknown container version');
  }
  const headerEnd = PREFIX_BYTES + bytes.readUInt32BE(2);
  if (headerEnd > bytes.length) {
    throw new E2eeRecordContainerError('Header overruns the container');
  }
  const header = parseHeader(bytes.subarray(PREFIX_BYTES, headerEnd));
  const { bins, named } = decodeBins(header, bytes, headerEnd, external);
  const ops: E2eeRowOp[] = header.ops.map((op) => {
    if (
      (op?.op !== 'put' && op?.op !== 'del') ||
      typeof op.table !== 'string' ||
      typeof op.row !== 'object' ||
      op.row === null
    ) {
      throw new E2eeRecordContainerError('Bad op');
    }
    const row = fromWireRow(op.row, bins);
    return op.op === 'put'
      ? { op: 'put', table: op.table, row }
      : { op: 'del', table: op.table, key: row };
  });
  return {
    type: header.type,
    pos: header.pos,
    prev: header.prev,
    ops,
    external: named
  };
}
