import { getBytes, keccak256 } from 'ethers';

// The drop archives' root, as the chain commits to it in a Waves v1 file,
// computed here from its definition (the chain spec's dropArchiveRoot, with
// the canonical encodings' H, TAG and list tree), not from the code that
// reads the archives, so a fault there can't agree with itself.

/** Keccak-256 (Ethereum's, not SHA3-256), as 32 bytes. */
function keccak(...parts: Uint8Array[]): Buffer {
  // One part hashes as it is: a large file is not copied first.
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  return Buffer.from(getBytes(keccak256(bytes)));
}

/** Keccak-256 of bytes, as 64 lowercase hex digits. */
export function keccakHex(bytes: Uint8Array): string {
  return keccak(bytes).toString('hex');
}

/** TAG(name): Keccak-256 of the name's ASCII bytes. */
export function tag(name: string): Buffer {
  return keccak(Buffer.from(name, 'ascii'));
}

const LEAF = tag('6529.DropArchive.v1');
const NODE = tag('6529.MerkleNode.v1');
const ROOT = tag('6529.DropArchives.v1');
const DERIVED_ID = tag('6529.DerivedId.v1');

/** A number as one big-endian 32-byte word. */
export function word(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
}

/**
 * The list tree's top: pairs adjacent entries left to right with NODE, an
 * odd last entry going up unchanged, until one remains; 32 zero bytes for
 * an empty list.
 */
function top(leaves: readonly Buffer[]): Buffer {
  if (!leaves.length) return Buffer.alloc(32);
  let level = leaves.slice();
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? keccak(NODE, level[i], level[i + 1]) : level[i]
      );
    }
    level = next;
  }
  return level[0];
}

/**
 * ROOT(rootClass, L) = H(rootClass, uint64 len(L), bytes32 TOP(L)): the
 * canonical encodings' root of a list, bound to its length.
 */
export function listRoot(rootTag: Buffer, leaves: readonly Buffer[]): string {
  return keccak(rootTag, word(BigInt(leaves.length)), top(leaves)).toString(
    'hex'
  );
}

/** H(name, words): Keccak-256 of TAG(name) followed by 32-byte words. */
export function taggedHash(nameTag: Buffer, ...words: Buffer[]): Buffer {
  return keccak(nameTag, ...words);
}

export const HEX32 = /^[0-9a-f]{64}$/;

/** One archive of an index: its wave and the Keccak-256 of its bytes. */
export interface DropArchiveEntry {
  readonly waveId: string;
  readonly hash: string;
}

/**
 * dropArchiveRoot over the entries, which must be strictly ascending by
 * waveId (so no wave twice), each field 64 lowercase hex digits.
 * Throws on anything else.
 */
export function dropArchiveRoot(entries: readonly DropArchiveEntry[]): string {
  entries.forEach((entry, i) => {
    if (!HEX32.test(entry.waveId) || !HEX32.test(entry.hash)) {
      throw new Error(
        `archive ${i + 1}: waveId and hash must be 64 lowercase hex digits`
      );
    }
    // Lowercase hex of equal length orders as the numbers do.
    if (i > 0 && entries[i - 1].waveId >= entry.waveId) {
      throw new Error(
        `archive ${i + 1}: waveIds must be strictly ascending (${entries[i - 1].waveId} then ${entry.waveId})`
      );
    }
  });
  const leaves = entries.map((entry) =>
    keccak(
      LEAF,
      Buffer.from(entry.waveId, 'hex'),
      Buffer.from(entry.hash, 'hex')
    )
  );
  return listRoot(ROOT, leaves);
}

/**
 * The chain's wave id of a 6529.io wave: DerivedId of its UUID's 16 bytes
 * followed by 16 zero bytes, sequence 0, domain 0x0501.
 */
export function waveIdOf(legacyWave: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      legacyWave
    )
  ) {
    throw new Error(`${legacyWave} is not a lowercase UUID`);
  }
  return keccak(
    DERIVED_ID,
    Buffer.concat([
      Buffer.from(legacyWave.replace(/-/g, ''), 'hex'),
      Buffer.alloc(16)
    ]),
    word(BigInt(0)),
    word(BigInt(0x0501))
  ).toString('hex');
}

const WAVES_V1_SCHEMA = 0x411d;
const WAVES_V1_VERSION = 1;

/**
 * A Waves v1 file's dropArchiveRoot (bytes 96 to 128, after the schema,
 * version, freeze time, exporter revision, identities file hash and docs
 * root), or null when the bytes aren't a Waves v1 file.
 */
export function wavesFileDropArchiveRoot(bytes: Buffer): string | null {
  if (bytes.length < 128) return null;
  if (bytes.readUInt16BE(0) !== WAVES_V1_SCHEMA) return null;
  if (bytes.readUInt16BE(2) !== WAVES_V1_VERSION) return null;
  return bytes.subarray(96, 128).toString('hex');
}

/**
 * A Waves v1 file's docsRoot (bytes 64 to 96, after the identities file
 * hash), or null when the bytes aren't a Waves v1 file.
 */
export function wavesFileDocsRoot(bytes: Buffer): string | null {
  if (wavesFileDropArchiveRoot(bytes) === null) return null;
  return bytes.subarray(64, 96).toString('hex');
}

/**
 * The Waves v1 file hashes the chain gives in recorded answers to its
 * import route: exchanges keyed as a GET of `/v1/waves/import` (by key,
 * as the replay serves them), answered 200 with a completed import, each
 * `data.fileHash` as 64 lowercase hex digits, distinct and in order.
 */
export function importAnswerFileHashes(
  exchanges: Iterable<{
    readonly key: string;
    readonly status: number;
    readonly body: string;
    readonly encoding?: string;
  }>
): string[] {
  const hashes = new Set<string>();
  for (const exchange of Array.from(exchanges)) {
    if (!/^GET \/v1\/waves\/import(?:\?\S*)? /.test(exchange.key)) continue;
    if (exchange.status !== 200 || exchange.encoding === 'base64') continue;
    let body: { data?: { fileHash?: unknown; completed?: unknown } };
    try {
      body = JSON.parse(exchange.body);
    } catch {
      continue;
    }
    if (body?.data?.completed !== true) continue;
    const fileHash = body.data.fileHash;
    if (typeof fileHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(fileHash)) {
      hashes.add(fileHash.slice(2).toLowerCase());
    }
  }
  return Array.from(hashes).sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** What checking a drop archive index found. */
export interface DropArchiveIndexCheck {
  /** The archives it attests: each hash, with the size it lists. */
  readonly archives: Map<string, number | null>;
  /** The same archives by wave: each waveId's hash. */
  readonly waves: Map<string, string>;
  /** Faults in the index, or a root that differs: each fails the run. */
  readonly problems: string[];
  /**
   * Why the index couldn't be checked against the chain (no Waves v1
   * file the chain names is served), or null.
   */
  readonly waiting: string | null;
}

/**
 * Checks a drop archive index (the snapshot tool's archives/index.json).
 * Each entry needs a waveId, a hash and the 6529.io wave UUID that
 * derives the waveId; the pairs must be strictly ascending by waveId; the
 * index's own dropArchiveRoot, when it gives one, must be the root of its
 * pairs. Those faults are problems. Then the root must equal the
 * dropArchiveRoot of a Waves v1 file the chain names (`chainRoots`):
 * with none to check against the index waits, attesting nothing and
 * failing nothing; with a different root it fails.
 */
export function checkDropArchiveIndex(
  indexBytes: Buffer,
  chainRoots: readonly string[]
): DropArchiveIndexCheck {
  const none = (problems: string[]): DropArchiveIndexCheck => ({
    archives: new Map(),
    waves: new Map(),
    problems,
    waiting: null
  });
  let index: { archives?: unknown; dropArchiveRoot?: unknown };
  try {
    index = JSON.parse(indexBytes.toString('utf8'));
  } catch {
    return none(['the drop archive index is not JSON']);
  }
  if (!Array.isArray(index?.archives)) {
    return none(['the drop archive index has no archives list']);
  }
  const problems: string[] = [];
  const entries: (DropArchiveEntry & {
    legacyWave: string;
    bytes: number | null;
  })[] = [];
  index.archives.forEach((archive: Record<string, unknown>, i: number) => {
    const { waveId, hash, legacyWave, bytes } = archive ?? {};
    if (
      typeof waveId !== 'string' ||
      typeof hash !== 'string' ||
      typeof legacyWave !== 'string'
    ) {
      problems.push(
        `the drop archive index's archive ${i + 1} lacks a waveId, hash or legacyWave string`
      );
      return;
    }
    if (
      bytes !== undefined &&
      !(typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0)
    ) {
      problems.push(
        `the drop archive index's archive ${i + 1} gives a size that isn't a whole number of bytes`
      );
      return;
    }
    entries.push({
      waveId,
      hash,
      legacyWave,
      bytes: typeof bytes === 'number' ? bytes : null
    });
  });
  if (problems.length) return none(problems);
  let root: string;
  try {
    root = dropArchiveRoot(entries);
  } catch (error) {
    return none([`the drop archive index: ${(error as Error).message}`]);
  }
  if (index.dropArchiveRoot !== undefined && index.dropArchiveRoot !== root) {
    problems.push(
      `the drop archive index gives dropArchiveRoot ${String(index.dropArchiveRoot)}, but its archives' root is ${root}`
    );
  }
  for (const entry of entries) {
    let derived: string;
    try {
      derived = waveIdOf(entry.legacyWave);
    } catch (error) {
      problems.push(`the drop archive index: ${(error as Error).message}`);
      continue;
    }
    if (derived !== entry.waveId) {
      problems.push(
        `the drop archive index lists wave ${entry.waveId} for ${entry.legacyWave}, whose wave id is ${derived}`
      );
    }
  }
  if (problems.length) return none(problems);
  if (!chainRoots.length) {
    return {
      archives: new Map(),
      waves: new Map(),
      problems: [],
      waiting:
        "no Waves v1 file the chain names (a recorded import answer's fileHash) is served, so the drop archive index can't be checked against the chain"
    };
  }
  if (!chainRoots.includes(root)) {
    return none([
      `the drop archive index's root ${root} is not the dropArchiveRoot of the Waves v1 file the chain names`
    ]);
  }
  return {
    archives: new Map(entries.map((e) => [e.hash, e.bytes])),
    waves: new Map(entries.map((e) => [e.waveId, e.hash])),
    problems: [],
    waiting: null
  };
}
