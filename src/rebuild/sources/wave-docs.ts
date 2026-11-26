import {
  HEX32,
  keccakHex,
  listRoot,
  tag,
  taggedHash,
  word
} from '@/rebuild/sources/drop-archives';

// The Waves v1 file's docsRoot, computed here from its definition (the
// snapshot tool's and the chain spec's: the wave documents the Waves v1 file
// commits to, the canonical encodings' H and list root), not from the code
// that reads the documents.

const DOC = tag('6529.WaveDoc.v1');
const DOCS = tag('6529.WaveDocs.v1');
/** A raw sha2-256 CIDv1, in lowercase hex: 01 55 12 20 and the digest. */
const RAW_CID = /^01551220[0-9a-f]{64}$/;

/** One document of the docs index. */
export interface WaveDocEntry {
  /** The document class (3 a wave; 6, 7 and 11 groups; 10 a decision; ...). */
  readonly docClass: number;
  /** The document's reference: Keccak-256 of its CID, or its commitment. */
  readonly ref: string;
  /** Keccak-256 of the document's bytes. */
  readonly hash: string;
  /** The CID's bytes in hex, for a document named by one; else null. */
  readonly cid: string | null;
  /**
   * The raw sha2-256 CIDv1 of the document's own bytes, in hex: the name
   * the files source serves every document under (a CID document's is
   * its cid).
   */
  readonly rawCid: string;
}

/**
 * docsRoot over the entries: ROOT("6529.WaveDocs.v1", [H("6529.WaveDoc.v1",
 * uint8 docClass, bytes32 ref, bytes32 hash)]), the entries strictly
 * ascending by (docClass, ref), so none twice. Throws on anything else.
 */
export function docsRoot(entries: readonly WaveDocEntry[]): string {
  entries.forEach((entry, i) => {
    if (
      !Number.isInteger(entry.docClass) ||
      entry.docClass < 0 ||
      entry.docClass > 255 ||
      !HEX32.test(entry.ref) ||
      !HEX32.test(entry.hash)
    ) {
      throw new Error(
        `document ${i + 1}: docClass must be 0 to 255, ref and hash 64 lowercase hex digits`
      );
    }
    const before = entries[i - 1];
    if (
      before &&
      (before.docClass > entry.docClass ||
        (before.docClass === entry.docClass && before.ref >= entry.ref))
    ) {
      throw new Error(
        `document ${i + 1}: documents must be strictly ascending by docClass, then ref`
      );
    }
  });
  return listRoot(
    DOCS,
    entries.map((entry) =>
      taggedHash(
        DOC,
        word(BigInt(entry.docClass)),
        Buffer.from(entry.ref, 'hex'),
        Buffer.from(entry.hash, 'hex')
      )
    )
  );
}

/** What checking a docs index found. */
export interface DocsIndexCheck {
  /** The documents it attests, once its root is the chain's. */
  readonly docs: WaveDocEntry[];
  /** Faults in the index, or a root that differs: each fails the run. */
  readonly problems: string[];
  /** Why the index couldn't be checked against the chain yet, or null. */
  readonly waiting: string | null;
}

/**
 * Checks a docs index (the snapshot tool's docs/index.json): each entry
 * needs a docClass, a ref, a hash and the rawCid it is served under, and,
 * when it names a CID, that CID as its rawCid and a ref that is the CID's
 * Keccak-256; the entries must be strictly ascending by
 * (docClass, ref); the index's own docsRoot, when it gives one, must be
 * the root of its entries. Those faults are problems. Then the root must
 * equal the docsRoot of a Waves v1 file the chain names (`chainRoots`):
 * with none to check against it waits, with a different root it fails.
 */
export function checkDocsIndex(
  indexBytes: Buffer,
  chainRoots: readonly string[]
): DocsIndexCheck {
  const none = (problems: string[]): DocsIndexCheck => ({
    docs: [],
    problems,
    waiting: null
  });
  let index: { docs?: unknown; docsRoot?: unknown };
  try {
    index = JSON.parse(indexBytes.toString('utf8'));
  } catch {
    return none(['the docs index is not JSON']);
  }
  if (!Array.isArray(index?.docs)) {
    return none(['the docs index has no docs list']);
  }
  const problems: string[] = [];
  const entries: WaveDocEntry[] = [];
  index.docs.forEach((doc: Record<string, unknown>, i: number) => {
    const { docClass, ref, hash, cid, rawCid } = doc ?? {};
    const bad = (detail: string) =>
      problems.push(`the docs index's document ${i + 1} ${detail}`);
    if (
      typeof docClass !== 'number' ||
      typeof ref !== 'string' ||
      typeof hash !== 'string' ||
      !(cid === undefined || cid === null || typeof cid === 'string')
    ) {
      bad('lacks a docClass number, or a ref or hash string');
      return;
    }
    if (typeof rawCid !== 'string' || !RAW_CID.test(rawCid)) {
      bad(
        'gives no rawCid, the raw sha2-256 CIDv1 of its bytes in lowercase hex, the name it is served under'
      );
      return;
    }
    if (typeof cid === 'string') {
      if (cid !== rawCid) {
        bad(
          `gives cid ${cid}, but rawCid ${rawCid}: a CID document is served under its CID`
        );
        return;
      }
      if (keccakHex(Buffer.from(cid, 'hex')) !== ref) {
        bad(`gives ref ${ref}, which isn't its CID's Keccak-256`);
        return;
      }
    }
    entries.push({
      docClass,
      ref,
      hash,
      cid: typeof cid === 'string' ? cid : null,
      rawCid
    });
  });
  if (problems.length) return none(problems);
  let root: string;
  try {
    root = docsRoot(entries);
  } catch (error) {
    return none([`the docs index: ${(error as Error).message}`]);
  }
  if (index.docsRoot !== undefined && index.docsRoot !== root) {
    return none([
      `the docs index gives docsRoot ${String(index.docsRoot)}, but its documents' root is ${root}`
    ]);
  }
  if (!chainRoots.length) {
    return {
      docs: [],
      problems: [],
      waiting:
        "no Waves v1 file the chain names is served, so the docs index can't be checked against the chain"
    };
  }
  if (!chainRoots.includes(root)) {
    return none([
      `the docs index's root ${root} is not the docsRoot of the Waves v1 file the chain names`
    ]);
  }
  return { docs: entries, problems: [], waiting: null };
}
