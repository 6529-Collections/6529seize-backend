import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import {
  RecordGrantProof,
  SignedRecordEvent,
  SignedRecordEventSchema
} from '../record-event';
import { parseFamilyWave } from '../record-families';
import { RecordGrantProofSchema } from '../record-grant-proofs';
import {
  hpkeOpenBase,
  hpkeSealBase,
  ProviderKey,
  providerRecipient
} from '../sealed-crypto';

/**
 * The interim record log: until the relays carry per-person streams,
 * 6529.io's service identity batches signed records into hash-chained
 * segment files, pins them to IPFS, archives them to Arweave and posts each
 * segment's head as a signed drop in one public wave. Public streams go to
 * the public chain; everything else goes to the private chain, whose files
 * are sealed to 6529.io's provider keys.
 */
export type RecordLogChain = 'public' | 'private';

export type RecordLogEntry =
  | {
      readonly t: 'event';
      readonly lane: string;
      readonly event: SignedRecordEvent;
      readonly grant: RecordGrantProof;
    }
  | {
      // A service entry with no signature of its own: the service
      // identity's signed head drop attests it.
      readonly t: 'entry';
      readonly lane: string;
      readonly chain: RecordLogChain;
      readonly body: Record<string, unknown>;
    };

export interface RecordLogSegmentHeader {
  readonly t: 'segment';
  readonly v: 1;
  readonly chain: RecordLogChain;
  readonly seq: number;
  // sha256 hex of the previous segment file of this chain; null for seq 1.
  readonly prev: string | null;
  readonly opened_at: number;
  readonly closed_at: number;
  readonly entries: number;
}

export interface RecordLogHead {
  readonly chain: RecordLogChain;
  readonly seq: number;
  readonly sha256: string;
  readonly cid: string;
  readonly prev: string | null;
  readonly entries: number;
}

export interface RecordLogArchive {
  readonly chain: RecordLogChain;
  readonly seq: number;
  readonly sha256: string;
  readonly arweaveTx: string;
}

export class RecordLogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordLogFormatError';
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, RecordLogFormatError.prototype);
  }
}

const LANE = /^[a-z0-9-]{1,32}$/;
/** The largest entry the log takes (canonical JSON bytes). */
export const RECORD_LOG_ENTRY_MAX_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const CID = /^[A-Za-z0-9]{10,128}$/;
const ARWEAVE_TX = /^[A-Za-z0-9_-]{43}$/;
const SEGMENT_INFO = '6529.RecordLogSegment.v1';

const fail = (message: string): never => {
  throw new RecordLogFormatError(message);
};

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Public streams go to the public chain, everything else to the private one. */
export function chainOfEntry(entry: RecordLogEntry): RecordLogChain {
  if (entry.t === 'entry') {
    return entry.chain;
  }
  return parseFamilyWave(entry.event.wave)?.family === 'ps'
    ? 'public'
    : 'private';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks an entry's shape; event entries keep their signed fields exactly. */
export function checkLogEntry(value: unknown): RecordLogEntry {
  if (!isPlainObject(value) || typeof value.lane !== 'string') {
    return fail('log entry must be an object with a lane');
  }
  if (!LANE.test(value.lane)) {
    return fail(`invalid lane ${value.lane}`);
  }
  if (value.t === 'event') {
    const { error, value: event } = SignedRecordEventSchema.validate(
      value.event
    );
    const proof = RecordGrantProofSchema.validate(value.grant);
    if (error || proof.error || Object.keys(value).length !== 4) {
      return fail('event entry must be {t, lane, event, grant}');
    }
    const grant: RecordGrantProof = proof.value;
    // The proof must be the grant the event names, for its key and wallet.
    if (
      grant.id !== event.auth_ref ||
      grant.device_key !== event.device_key ||
      grant.wallet !== event.author
    ) {
      return fail('the grant proof does not match the event');
    }
    return { t: 'event', lane: value.lane, event, grant };
  }
  if (
    value.t === 'entry' &&
    (value.chain === 'public' || value.chain === 'private') &&
    isPlainObject(value.body) &&
    Object.keys(value).length === 4
  ) {
    return {
      t: 'entry',
      lane: value.lane,
      chain: value.chain,
      body: value.body
    };
  }
  return fail('log entry must be an event or a service entry');
}

function linesOf(
  header: RecordLogSegmentHeader,
  entries: readonly RecordLogEntry[]
) {
  return Buffer.from(
    [header, ...entries].map((line) => `${canonicalizeJson(line)}\n`).join(''),
    'utf8'
  );
}

/** A segment file: canonical JSON lines, sealed to the providers for the private chain. */
export function buildSegmentFile(args: {
  readonly header: RecordLogSegmentHeader;
  readonly entries: readonly RecordLogEntry[];
  readonly providers: readonly Pick<ProviderKey, 'id' | 'publicKey'>[];
}): Buffer {
  const { header, entries } = args;
  if (header.entries !== entries.length) {
    fail('header entry count does not match');
  }
  if (entries.some((entry) => chainOfEntry(entry) !== header.chain)) {
    fail('an entry belongs to the other chain');
  }
  const plain = linesOf(header, entries);
  if (header.chain === 'public') {
    return plain;
  }
  if (args.providers.length === 0) {
    fail('the private chain needs at least one provider key');
  }
  const fileKey = randomBytes(32);
  const info = Buffer.from(`${SEGMENT_INFO}|${header.seq}`, 'utf8');
  const wraps = args.providers.map((provider) => {
    const { enc, ct } = hpkeSealBase({
      recipientPublicKey: provider.publicKey,
      info,
      aad: Buffer.alloc(0),
      plaintext: fileKey
    });
    return {
      to: providerRecipient(provider),
      enc: enc.toString('base64url'),
      ct: ct.toString('base64url')
    };
  });
  const nonce = randomBytes(12);
  const sealedHeader = canonicalizeJson({
    chain: 'private',
    nonce: nonce.toString('base64url'),
    seq: header.seq,
    t: 'sealed-segment',
    v: 1,
    wraps
  });
  const cipher = createCipheriv('aes-256-gcm', fileKey, nonce);
  cipher.setAAD(Buffer.from(sealedHeader, 'utf8'));
  const ct = Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return Buffer.from(`${sealedHeader}\n${ct.toString('base64url')}\n`, 'utf8');
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return fail('segment line is not JSON');
  }
}

function checkHeader(value: unknown): RecordLogSegmentHeader {
  const header = value as Partial<RecordLogSegmentHeader> | null;
  const valid =
    header?.t === 'segment' &&
    header.v === 1 &&
    (header.chain === 'public' || header.chain === 'private') &&
    Number.isSafeInteger(header.seq) &&
    (header.seq ?? 0) >= 1 &&
    (header.prev === null ||
      (typeof header.prev === 'string' && SHA256.test(header.prev))) &&
    Number.isSafeInteger(header.opened_at) &&
    Number.isSafeInteger(header.closed_at) &&
    Number.isSafeInteger(header.entries) &&
    Object.keys(header).length === 8;
  return valid
    ? (header as RecordLogSegmentHeader)
    : fail('bad segment header');
}

function parsePlain(text: string): {
  header: RecordLogSegmentHeader;
  entries: RecordLogEntry[];
} {
  if (!text.endsWith('\n')) {
    fail('segment does not end with a newline');
  }
  const lines = text.slice(0, -1).split('\n');
  for (const line of lines) {
    if (canonicalizeJson(parseJsonLine(line)) !== line) {
      fail('segment line is not canonical JSON');
    }
  }
  const header = checkHeader(parseJsonLine(lines[0]));
  const entries = lines.slice(1).map((line) => checkLogEntry(JSON.parse(line)));
  if (entries.length !== header.entries) {
    fail('segment entry count does not match its header');
  }
  if (entries.some((entry) => chainOfEntry(entry) !== header.chain)) {
    fail('segment holds an entry of the other chain');
  }
  return { header, entries };
}

/** Tries every wrap addressed to each provider key until one opens. */
function openFileKey(
  wraps: readonly { to: string; enc: string; ct: string }[],
  providers: readonly ProviderKey[],
  info: Buffer
): Buffer | null {
  for (const provider of providers) {
    for (const wrap of wraps) {
      if (wrap.to !== providerRecipient(provider)) {
        continue;
      }
      try {
        return hpkeOpenBase({
          recipientPrivateKey: provider.privateKey,
          enc: Buffer.from(wrap.enc, 'base64url'),
          info,
          aad: Buffer.alloc(0),
          ct: Buffer.from(wrap.ct, 'base64url')
        });
      } catch {
        // Another wrap or another provider key may open it.
      }
    }
  }
  return null;
}

function openPrivate(text: string, providers: readonly ProviderKey[]): string {
  const newline = text.indexOf('\n');
  const sealedHeader = text.slice(0, newline);
  const parsed = parseJsonLine(sealedHeader) as {
    chain?: unknown;
    nonce?: unknown;
    seq?: unknown;
    t?: unknown;
    wraps?: { to: string; enc: string; ct: string }[];
  };
  if (
    parsed.t !== 'sealed-segment' ||
    parsed.chain !== 'private' ||
    typeof parsed.nonce !== 'string' ||
    !Number.isSafeInteger(parsed.seq) ||
    !Array.isArray(parsed.wraps)
  ) {
    fail('bad sealed segment header');
  }
  const info = Buffer.from(`${SEGMENT_INFO}|${String(parsed.seq)}`, 'utf8');
  const fileKey = openFileKey(parsed.wraps ?? [], providers, info);
  if (!fileKey) {
    return fail('no provider key opens this segment');
  }
  const ct = Buffer.from(text.slice(newline + 1).trimEnd(), 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    fileKey,
    Buffer.from(parsed.nonce as string, 'base64url')
  );
  decipher.setAAD(Buffer.from(sealedHeader, 'utf8'));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  try {
    return Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - 16)),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return fail('sealed segment does not open');
  }
}

/** Parses (and for the private chain opens) a segment file. */
export function parseSegmentFile(
  bytes: Buffer,
  providers: readonly ProviderKey[]
): { header: RecordLogSegmentHeader; entries: RecordLogEntry[] } {
  const text = bytes.toString('utf8');
  const sealed = text.startsWith('{"chain":"private","nonce"');
  const parsed = parsePlain(sealed ? openPrivate(text, providers) : text);
  if (sealed !== (parsed.header.chain === 'private')) {
    fail('segment sealing does not match its chain');
  }
  return parsed;
}

const HEAD_TITLE = '6529.io records';
const ARCHIVE_TITLE = '6529.io records archive';

/** The text of a head drop. */
export function formatHeadDrop(head: RecordLogHead): string {
  return [
    HEAD_TITLE,
    `chain: ${head.chain}`,
    `seq: ${head.seq}`,
    `sha256: ${head.sha256}`,
    `cid: ${head.cid}`,
    `prev: ${head.prev ?? 'none'}`,
    `entries: ${head.entries}`
  ].join('\n');
}

/** Reads a head drop's text; null for any other drop in the wave. */
export function parseHeadDrop(text: string): RecordLogHead | null {
  const lines = text.trim().split('\n');
  if (lines.length !== 7 || lines[0] !== HEAD_TITLE) {
    return null;
  }
  const field = (index: number, name: string) => {
    const prefix = `${name}: `;
    return lines[index].startsWith(prefix)
      ? lines[index].slice(prefix.length)
      : null;
  };
  const chain = field(1, 'chain');
  const seq = Number(field(2, 'seq'));
  const sha256 = field(3, 'sha256');
  const cid = field(4, 'cid');
  const prev = field(5, 'prev');
  const entries = Number(field(6, 'entries'));
  if (
    (chain !== 'public' && chain !== 'private') ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !sha256 ||
    !SHA256.test(sha256) ||
    !cid ||
    !CID.test(cid) ||
    !prev ||
    (prev !== 'none' && !SHA256.test(prev)) ||
    !Number.isSafeInteger(entries) ||
    entries < 1
  ) {
    return null;
  }
  return {
    chain,
    seq,
    sha256,
    cid,
    prev: prev === 'none' ? null : prev,
    entries
  };
}

export function formatArchiveDrop(
  archives: readonly RecordLogArchive[]
): string {
  return [
    ARCHIVE_TITLE,
    ...archives.map(
      (it) => `${it.chain} ${it.seq} ${it.sha256} ${it.arweaveTx}`
    )
  ].join('\n');
}

export function parseArchiveDrop(text: string): RecordLogArchive[] | null {
  const [title, ...lines] = text.trim().split('\n');
  if (title !== ARCHIVE_TITLE || lines.length === 0) {
    return null;
  }
  const archives: RecordLogArchive[] = [];
  for (const line of lines) {
    const [chain, seq, sha256, arweaveTx, ...rest] = line.split(' ');
    if (
      rest.length > 0 ||
      (chain !== 'public' && chain !== 'private') ||
      !Number.isSafeInteger(Number(seq)) ||
      !SHA256.test(sha256 ?? '') ||
      !ARWEAVE_TX.test(arweaveTx ?? '')
    ) {
      return null;
    }
    archives.push({ chain, seq: Number(seq), sha256, arweaveTx });
  }
  return archives;
}
