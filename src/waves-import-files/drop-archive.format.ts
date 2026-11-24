import { ethers } from 'ethers';

/**
 * The 6529 chain's commitments to 6529.io's drops from before the waves
 * switch, as the snapshot tooling writes them and the chain's Waves v1 file
 * commits them (validator repository, tools/legacy-snapshot and
 * crates/chain-tx/src/waves_file.rs):
 *
 * - One drop archive per wave with drops: canonical JSON lines (keys sorted
 *   by code point, no whitespace, UTF-8, integers only), one drop a line,
 *   a newline after each, ascending by serial number. It is named by the
 *   chain's wave id, `DerivedId(uuid || 16 zero bytes, 0, 0x0501)`.
 * - `dropArchiveRoot`, in the Waves v1 file's header: the list root
 *   `ROOT("6529.DropArchives.v1", [H("6529.DropArchive.v1", waveId,
 *   keccak256(archive))])`, ascending by wave id.
 * - The Waves v1 file's keccak256 is the hash the chain's waves import
 *   names, so the chain fixes the file, the file fixes the root, and the
 *   root fixes every archive's bytes.
 */

export const WAVES_FILE_SCHEMA = 0x411d;
export const WAVES_FILE_VERSION = 1;
/** The chain's WAVE kind, for a wave's id. */
export const WAVE_KIND = 0x0501;
/** The chain's PRINCIPAL kind, for an author's principal. */
export const PRINCIPAL_KIND = 0x0101;

const ZERO32 = new Uint8Array(32);

export function keccak256Hex(bytes: Uint8Array): string {
  return ethers.keccak256(bytes).toLowerCase();
}

function tag(name: string): Uint8Array {
  return ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

/** A static ABI word: 32 bytes as they are, or an unsigned integer. */
type Word = Uint8Array | bigint | number;

function word(value: Word): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) {
      throw new Error(`A word is 32 bytes, not ${value.length}`);
    }
    return value;
  }
  const n = BigInt(value);
  if (n < BigInt(0)) throw new Error('A word holds no negative number');
  return ethers.getBytes(ethers.zeroPadValue(ethers.toBeHex(n), 32));
}

/** H(name, fields) = keccak256(TAG(name) || the fields as words) (P28 2.7). */
export function taggedHash(name: string, ...fields: Word[]): Uint8Array {
  return ethers.getBytes(
    ethers.keccak256(ethers.concat([tag(name), ...fields.map(word)]))
  );
}

/** TOP(L): pairs hashed up the tree, an odd last node carried (P28 3.3). */
function listTop(leaves: readonly Uint8Array[]): Uint8Array {
  if (!leaves.length) return ZERO32;
  const nodeTag = tag('6529.MerkleNode.v1');
  let level = [...leaves];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length
          ? ethers.getBytes(
              ethers.keccak256(ethers.concat([nodeTag, level[i], level[i + 1]]))
            )
          : level[i]
      );
    }
    level = next;
  }
  return level[0];
}

/** ROOT(rootClass, L) = H(rootClass, uint64 len(L), bytes32 TOP(L)). */
export function listRoot(
  rootClass: string,
  leaves: readonly Uint8Array[]
): Uint8Array {
  return taggedHash(rootClass, leaves.length, listTop(leaves));
}

/** A 6529.io UUID's 16 bytes, or null when it is not a UUID. */
export function uuidBytes(uuid: string): Uint8Array | null {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      uuid
    )
  ) {
    return null;
  }
  return ethers.getBytes(`0x${uuid.replace(/-/g, '')}`);
}

/**
 * The chain's id of a 6529.io object, `DerivedId(uuid || 16 zero bytes, 0,
 * kind)`, in lowercase hex with 0x; null when `uuid` is not a UUID.
 */
export function legacyDerivedId(uuid: string, kind: number): string | null {
  const bytes = uuidBytes(uuid);
  if (!bytes) return null;
  const parent = ethers.getBytes(ethers.concat([bytes, new Uint8Array(16)]));
  return ethers.hexlify(taggedHash('6529.DerivedId.v1', parent, 0, kind));
}

/** One archive's place in `dropArchiveRoot`: its wave id and keccak256. */
export interface DropArchiveLeaf {
  /** 0x and 64 lowercase hex digits. */
  readonly waveId: string;
  /** 0x and 64 lowercase hex digits. */
  readonly hash: string;
}

/** `dropArchiveRoot` over `leaves`, which must be ascending by wave id. */
export function dropArchiveRoot(leaves: readonly DropArchiveLeaf[]): string {
  return ethers.hexlify(
    listRoot(
      '6529.DropArchives.v1',
      leaves.map((leaf) =>
        taggedHash(
          '6529.DropArchive.v1',
          ethers.getBytes(leaf.waveId),
          ethers.getBytes(leaf.hash)
        )
      )
    )
  );
}

export interface WavesFileHeader {
  readonly freezeMs: number;
  /** 0x and 64 lowercase hex digits. */
  readonly docsRoot: string;
  /** 0x and 64 lowercase hex digits. */
  readonly dropArchiveRoot: string;
}

/** schema, version, freezeMs, revision, three roots, mainStage, its decision, ten counts. */
const HEADER_BYTES = 2 + 2 + 8 + 20 + 32 + 32 + 32 + 1 + 16 + 10 * 4;

/** The Waves v1 file's header fields the reader uses; throws on another file. */
export function readWavesFileHeader(file: Uint8Array): WavesFileHeader {
  if (file.length < HEADER_BYTES) {
    throw new Error(`A Waves v1 file has at least ${HEADER_BYTES} bytes`);
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const schema = view.getUint16(0);
  const version = view.getUint16(2);
  if (schema !== WAVES_FILE_SCHEMA || version !== WAVES_FILE_VERSION) {
    throw new Error(
      `Not a Waves v1 file: schema 0x${schema.toString(16)}, version ${version}`
    );
  }
  const freezeMs = view.getBigUint64(4);
  const at = (offset: number) =>
    ethers.hexlify(file.subarray(offset, offset + 32));
  return {
    freezeMs: Number(freezeMs),
    docsRoot: at(64),
    dropArchiveRoot: at(96)
  };
}

/** A wave row of the Waves v1 file: its 6529.io id and its document's CID. */
export interface WavesFileWave {
  /** 6529.io's wave id, a lowercase UUID. */
  readonly legacyWave: string;
  /** The wave document's CID, 0x and hex. */
  readonly metadataCid: string;
}

/** A reader of the file's canonical encoding (P28 2.6): big-endian, no padding. */
class CeReader {
  private at = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): number {
    const at = this.at;
    if (at + n > this.bytes.length) {
      throw new Error('The Waves v1 file ends inside a row');
    }
    this.at += n;
    return at;
  }

  skip(n: number): void {
    this.need(n);
  }

  u32(): number {
    return this.view.getUint32(this.need(4));
  }

  take(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.subarray(at, at + n);
  }
}

function uuidOf(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Row sizes of the lists before the waves (crates/chain-tx waves_file.rs). */
const CLAUSE_BYTES = 1 + 32 + 16 + 8 + 8;
const MEMBER_BYTES = 1 + 32;
const MEMBER_ROW_BYTES = 16 + 1 + MEMBER_BYTES;

/**
 * The Waves v1 file's wave rows: after the header come the group rows and
 * the member rows, then the waves (each a legacy id, controller, three
 * group ids, the document's CID, a status and a creation time).
 */
export function readWavesFileWaves(file: Uint8Array): WavesFileWave[] {
  readWavesFileHeader(file);
  const r = new CeReader(file);
  r.skip(HEADER_BYTES);
  const groups = r.u32();
  for (let g = 0; g < groups; g++) {
    // legacy id, controller, definition hash, predicate mode
    r.skip(16 + 16 + 32 + 1);
    r.skip(r.u32() * CLAUSE_BYTES);
    r.skip(r.u32() * MEMBER_BYTES); // includes
    r.skip(r.u32() * MEMBER_BYTES); // excludes
    r.skip(4 + 4 + 8); // stored includes, stored excludes, created
  }
  r.skip(r.u32() * MEMBER_ROW_BYTES);
  const count = r.u32();
  const waves: WavesFileWave[] = [];
  for (let w = 0; w < count; w++) {
    const legacyWave = uuidOf(r.take(16));
    r.skip(16 + 16 * 3); // controller, read, post and admin groups
    const cid = r.take(r.u32());
    r.skip(1 + 8); // status, created
    waves.push({
      legacyWave,
      metadataCid: `0x${Buffer.from(cid).toString('hex')}`
    });
  }
  return waves;
}

function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * One line of canonical JSON, as the snapshot tooling writes it (Python's
 * `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",",
 * ":"))`): keys sorted by code point, no whitespace, integers only.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Canonical JSON holds integers only, not ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    // Written key by key: an object's own order puts integer-like keys
    // first, which is not code point order.
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareCodePoints);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Canonical JSON holds no ${typeof value}`);
}
