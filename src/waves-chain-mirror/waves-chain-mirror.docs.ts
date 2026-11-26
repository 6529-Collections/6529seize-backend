import { getBytes, keccak256, toUtf8Bytes } from 'ethers';
import {
  bytesMatchCid,
  ChainGatewayClient,
  cidHex,
  rawCidHexOf
} from '@/chain-gateway/chain-gateway.client';

/**
 * Documents the chain names, and the checks the mirror makes before it uses
 * one, as the chain's off-chain document rules define them (the frontend's
 * lib/chain-waves/docs.ts and entryManifest.ts write them):
 *
 *   bytes       canonical JSON and a newline
 *   CID         0x01 0x55 0x12 0x20 || sha256(bytes) (raw, sha2-256)
 *   commitment  H("6529.OffchainDoc.v1", uint8 docClass, bytes32 nonce,
 *               bytes32 keccak256(bytes)), H(name, f...) being
 *               keccak256(keccak256(name) || f...) over 32-byte words
 *
 * The chain checks hashes, not content: a document that passes these checks
 * is still untrusted input.
 */

export const DOC_CLASS = {
  WAVE: 3,
  MODERATION_REASON: 4,
  GROUP: 6,
  OUTCOME_TEMPLATE: 7,
  ENTRY_MANIFEST: 8,
  DECISION: 10
} as const;

const OFFCHAIN_DOC_TAG = keccak256(toUtf8Bytes('6529.OffchainDoc.v1'));
const WORD = 32;
const NONCE_BYTES = 16;
/** An entry manifest larger than this is refused unread. */
export const MAX_MANIFEST_BYTES = 512 * 1024;

function uintWord(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`not a uint8: ${value}`);
  }
  const out = new Uint8Array(WORD);
  out[WORD - 1] = value;
  return out;
}

function bytes32(hex: string): Uint8Array {
  const raw = getBytes(hex);
  if (raw.length !== WORD) throw new RangeError('expected 32 bytes');
  return raw;
}

/** The raw sha2-256 CIDv1 of a document, as 0x hex. */
export function docCid(bytes: Uint8Array): string {
  return rawCidHexOf(bytes);
}

/** The chain's commitment of a document of `docClass` under `nonceWord`. */
export function docCommitment(
  docClass: number,
  nonceWord: string,
  bytes: Uint8Array
): string {
  const preimage = new Uint8Array(4 * WORD);
  preimage.set(getBytes(OFFCHAIN_DOC_TAG), 0);
  preimage.set(uintWord(docClass), WORD);
  preimage.set(bytes32(nonceWord), 2 * WORD);
  preimage.set(getBytes(keccak256(bytes)), 3 * WORD);
  return keccak256(preimage);
}

/**
 * A document's 128-bit nonce (0x and 32 hex digits) as the 32-byte word the
 * commitment takes: the nonce, then 16 zero bytes. Null when it isn't one.
 */
export function nonceWordOf(nonce: unknown): string | null {
  if (typeof nonce !== 'string') return null;
  const text = nonce.toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${2 * NONCE_BYTES}}$`).test(text)) return null;
  return `${text}${'00'.repeat(WORD - NONCE_BYTES)}`;
}

/** The fields of a version 1 entry manifest the mirror reads. */
export interface EntryManifest {
  readonly nonce: string;
  readonly decision: string;
  readonly wave: string;
  readonly author: string;
  readonly createdAt: number;
  readonly consent: Record<string, unknown> | null;
  /** Everything but the envelope: the entry under 6529.io's create-drop names. */
  readonly fields: Record<string, unknown>;
}

const ENVELOPE_KEYS = new Set([
  'v',
  'kind',
  'nonce',
  'decision',
  'wave',
  'author',
  'created_at',
  'consent'
]);

export type ManifestCheck =
  | { readonly ok: true; readonly manifest: EntryManifest }
  | { readonly ok: false; readonly reason: string };

/** What the chain says of an entry, which its manifest must match. */
export interface ManifestSubject {
  readonly entryId: string;
  readonly decisionId: string;
  readonly author: string;
  readonly manifestHash: string | null;
  readonly contentCid: string | null;
}

function lowerHex(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)
    ? value.toLowerCase()
    : null;
}

/**
 * Checks an entry manifest against its entry, as the frontend writes it:
 * the bytes are the content of `contentCid`, the commitment of class 8 under
 * the manifest's own nonce is `manifestHash`, it is a version 1 entry
 * manifest, and its `decision` and `author` are the entry's.
 */
export function checkEntryManifest(
  bytes: Uint8Array,
  entry: ManifestSubject
): ManifestCheck {
  const fail = (reason: string): ManifestCheck => ({ ok: false, reason });
  const contentCid = lowerHex(entry.contentCid);
  const manifestHash = lowerHex(entry.manifestHash);
  if (!contentCid || !manifestHash) return fail('no_manifest_reference');
  if (bytes.length > MAX_MANIFEST_BYTES) return fail('manifest_too_large');
  let cid: string;
  try {
    cid = cidHex(contentCid);
  } catch {
    return fail('bad_content_cid');
  }
  if (!bytesMatchCid(cid, bytes) || docCid(bytes) !== cid) {
    return fail('cid_mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return fail('not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('not_an_object');
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.v !== 1 || doc.kind !== 'entry') return fail('not_an_entry_manifest');
  const nonceWord = nonceWordOf(doc.nonce);
  if (!nonceWord) return fail('bad_nonce');
  if (
    docCommitment(DOC_CLASS.ENTRY_MANIFEST, nonceWord, bytes) !== manifestHash
  ) {
    return fail('commitment_mismatch');
  }
  if (lowerHex(doc.decision) !== entry.decisionId.toLowerCase()) {
    return fail('decision_mismatch');
  }
  if (lowerHex(doc.author) !== entry.author.toLowerCase()) {
    return fail('author_mismatch');
  }
  const wave = lowerHex(doc.wave);
  const createdAt = Number(doc.created_at);
  if (!wave || !Number.isSafeInteger(createdAt)) {
    return fail('bad_envelope');
  }
  const consent =
    doc.consent && typeof doc.consent === 'object'
      ? (doc.consent as Record<string, unknown>)
      : null;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!ENVELOPE_KEYS.has(key)) fields[key] = value;
  }
  return {
    ok: true,
    manifest: {
      nonce: String(doc.nonce).toLowerCase(),
      decision: entry.decisionId.toLowerCase(),
      wave,
      author: entry.author.toLowerCase(),
      createdAt,
      consent,
      fields
    }
  };
}

/** The largest document of a class the mirror keeps. */
export function maxDocumentBytes(docClass: number): number {
  return docClass === DOC_CLASS.ENTRY_MANIFEST
    ? MAX_MANIFEST_BYTES
    : 2 * MAX_MANIFEST_BYTES;
}

/** Where the mirror reads documents from. */
export interface DocumentSource {
  /** The bytes of `cid`, checked against it; null when no store has it. */
  get(cid: string, docClass: number): Promise<Uint8Array | null>;
}

/** The mirror's own copy of documents (chain_docs). */
export interface DocumentCache {
  findDocument(cid: string): Promise<Uint8Array | null>;
  saveDocument(cid: string, docClass: number, bytes: Uint8Array): Promise<void>;
}

/**
 * Documents from chain_docs, else from the gateway's store (which checks the
 * CID; checked again here). With `keep`, a fetched document is saved to
 * chain_docs; a report-only run keeps nothing.
 */
export class StoredDocuments implements DocumentSource {
  constructor(
    private readonly cache: DocumentCache,
    private readonly gateway: Pick<ChainGatewayClient, 'getDocument'>,
    private readonly keep: boolean
  ) {}

  async get(cid: string, docClass: number): Promise<Uint8Array | null> {
    const key = cidHex(cid);
    const cached = await this.cache.findDocument(key);
    if (cached && bytesMatchCid(key, cached)) return cached;
    const fetched = await this.gateway.getDocument(key);
    if (!fetched || !bytesMatchCid(key, fetched)) return null;
    const bytes = new Uint8Array(fetched);
    // Kept only within its class's size: a larger one is refused by its
    // check (and held), never stored.
    if (this.keep && bytes.length <= maxDocumentBytes(docClass)) {
      await this.cache.saveDocument(key, docClass, bytes);
    }
    return bytes;
  }
}
