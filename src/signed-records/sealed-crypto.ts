import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  KeyObject,
  randomBytes
} from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { isRecordKey, isRecordType } from './record-body';

/**
 * Sealed record contents (API section 2.1). A device seals items under its
 * own sender key S for (class, generation) and wraps S with HPKE (RFC 9180
 * base mode, X25519 / HKDF-SHA256 / AES-128-GCM) to each reader: 6529.io's
 * provider keys for the PROVIDER class, the person's other devices later.
 */
export const SealedClass = { PROVIDER: 1, OWN: 2 } as const;

export const SealedFormat = { ITEMS: 0x01, KEYS: 0x02 } as const;

export interface SealedItem {
  readonly t: string;
  readonly k: string;
  // null unsets the key.
  readonly b: Record<string, unknown> | null;
}

export interface KeyWrap {
  readonly cls: number;
  readonly gen: number;
  readonly from: string;
  readonly to: string;
  readonly enc: string;
  readonly ct: string;
}

export interface KeysDocument {
  readonly v: 1;
  readonly dev: string;
  readonly box: string | null;
  readonly wraps: readonly KeyWrap[];
}

export interface ProviderKey {
  readonly id: string;
  readonly privateKey: Buffer;
  readonly publicKey: Buffer;
}

export class SealedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedFormatError';
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, SealedFormatError.prototype);
  }
}

const SEALED_INFO = '6529.PersonalSealed.v1';
const WRAP_INFO = '6529.PersonalKeyWrap.v1';
const PADDING_BUCKETS = [256, 1024, 4096, 16384, 32768];
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// tag, cls, gen (u32), device key, nonce
const ITEMS_HEADER_BYTES = 1 + 1 + 4 + 32 + NONCE_BYTES;
const MAX_GENERATION = 0xffffffff;
const DEVICE_KEY = /^0x[0-9a-f]{64}$/;
const KEY_ID = /^[a-z0-9-]{1,32}$/;

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b656e04220420',
  'hex'
);

// ---- HKDF (RFC 5869) ----

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  // An empty salt is HashLen zero bytes (RFC 5869 2.2).
  return hmac(salt.length ? salt : Buffer.alloc(32), ikm);
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous: Buffer = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([i])]));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
}

// ---- X25519 ----

function x25519PrivateKey(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8'
  });
}

function x25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  });
}

function rawPublicKeyOf(key: KeyObject): Buffer {
  return Buffer.from(
    createPublicKey(key)
      .export({ format: 'der', type: 'spki' })
      .subarray(X25519_SPKI_PREFIX.length)
  );
}

export function x25519PublicKeyOf(privateKey: Buffer): Buffer {
  return rawPublicKeyOf(x25519PrivateKey(privateKey));
}

// ---- HPKE (RFC 9180), base mode, suite 0x0020 / 0x0001 / 0x0001 ----

const HPKE_V1 = Buffer.from('HPKE-v1');
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), u16(0x0020)]);
const HPKE_SUITE = Buffer.concat([
  Buffer.from('HPKE'),
  u16(0x0020),
  u16(0x0001),
  u16(0x0001)
]);
const EMPTY = Buffer.alloc(0);

function labeledExtract(
  suite: Buffer,
  salt: Buffer,
  label: string,
  ikm: Buffer
): Buffer {
  return hkdfExtract(
    salt,
    Buffer.concat([HPKE_V1, suite, Buffer.from(label), ikm])
  );
}

function labeledExpand(
  suite: Buffer,
  prk: Buffer,
  label: string,
  info: Buffer,
  length: number
): Buffer {
  return hkdfExpand(
    prk,
    Buffer.concat([u16(length), HPKE_V1, suite, Buffer.from(label), info]),
    length
  );
}

interface HpkeContext {
  readonly key: Buffer;
  readonly nonce: Buffer;
}

function hpkeKeySchedule(sharedSecret: Buffer, info: Buffer): HpkeContext {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, 16),
    nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12)
  };
}

function kemSharedSecret(dh: Buffer, enc: Buffer, recipient: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh);
  return labeledExpand(
    KEM_SUITE,
    eaePrk,
    'shared_secret',
    Buffer.concat([enc, recipient]),
    32
  );
}

/** One HPKE base-mode seal (sequence 0). Exported for the RFC vector test. */
export function hpkeSealBase(args: {
  recipientPublicKey: Buffer;
  info: Buffer;
  aad: Buffer;
  plaintext: Buffer;
  ephemeralPrivateKey?: Buffer;
}): { enc: Buffer; ct: Buffer } {
  const ephemeral = args.ephemeralPrivateKey
    ? x25519PrivateKey(args.ephemeralPrivateKey)
    : generateKeyPairSync('x25519').privateKey;
  const enc = rawPublicKeyOf(ephemeral);
  const dh = diffieHellman({
    privateKey: ephemeral,
    publicKey: x25519PublicKey(args.recipientPublicKey)
  });
  const { key, nonce } = hpkeKeySchedule(
    kemSharedSecret(dh, enc, args.recipientPublicKey),
    args.info
  );
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  cipher.setAAD(args.aad);
  const ct = Buffer.concat([
    cipher.update(args.plaintext),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return { enc, ct };
}

export function hpkeOpenBase(args: {
  recipientPrivateKey: Buffer;
  enc: Buffer;
  info: Buffer;
  aad: Buffer;
  ct: Buffer;
}): Buffer {
  if (args.enc.length !== KEY_BYTES || args.ct.length < TAG_BYTES) {
    throw new SealedFormatError('malformed HPKE ciphertext');
  }
  const recipient = x25519PrivateKey(args.recipientPrivateKey);
  const dh = diffieHellman({
    privateKey: recipient,
    publicKey: x25519PublicKey(args.enc)
  });
  const { key, nonce } = hpkeKeySchedule(
    kemSharedSecret(dh, args.enc, rawPublicKeyOf(recipient)),
    args.info
  );
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAAD(args.aad);
  decipher.setAuthTag(args.ct.subarray(args.ct.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(args.ct.subarray(0, args.ct.length - TAG_BYTES)),
    decipher.final()
  ]);
}

// ---- Sealed items (format 0x01) ----

function checkClassAndGeneration(cls: number, gen: number): void {
  if (cls !== SealedClass.PROVIDER && cls !== SealedClass.OWN) {
    throw new SealedFormatError(`unknown sealed class ${cls}`);
  }
  if (!Number.isInteger(gen) || gen < 1 || gen > MAX_GENERATION) {
    throw new SealedFormatError(`invalid generation ${gen}`);
  }
}

function itemsKey(senderKey: Buffer, wave: string, cls: number, gen: number) {
  if (senderKey.length !== KEY_BYTES) {
    throw new SealedFormatError('sender key must be 32 bytes');
  }
  const prk = hkdfExtract(Buffer.from(wave, 'utf8'), senderKey);
  return hkdfExpand(
    prk,
    Buffer.concat([Buffer.from(SEALED_INFO), Buffer.from([cls]), u32(gen)]),
    KEY_BYTES
  );
}

function itemsAad(wave: string, header: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${SEALED_INFO}|${wave}`, 'utf8'), header]);
}

function checkItem(item: unknown): SealedItem {
  const candidate = item as Partial<SealedItem> | null;
  const body = candidate?.b;
  const bodyValid =
    body === null ||
    (typeof body === 'object' && body !== undefined && !Array.isArray(body));
  if (
    typeof candidate?.t !== 'string' ||
    !isRecordType(candidate.t) ||
    typeof candidate.k !== 'string' ||
    !isRecordKey(candidate.k) ||
    !bodyValid ||
    Object.keys(candidate).length !== 3
  ) {
    throw new SealedFormatError('sealed item must be {"t","k","b"}');
  }
  return { t: candidate.t, k: candidate.k, b: body ?? null };
}

function pad(json: Buffer): Buffer {
  const size = PADDING_BUCKETS.find((bucket) => bucket >= 4 + json.length);
  if (size === undefined) {
    throw new SealedFormatError('sealed items are too large');
  }
  const plaintext = Buffer.alloc(size);
  plaintext.writeUInt32BE(json.length, 0);
  json.copy(plaintext, 4);
  return plaintext;
}

function unpad(plaintext: Buffer): Buffer {
  if (!PADDING_BUCKETS.includes(plaintext.length)) {
    throw new SealedFormatError('sealed plaintext is not a padding bucket');
  }
  const length = plaintext.readUInt32BE(0);
  if (length > plaintext.length - 4) {
    throw new SealedFormatError('sealed plaintext length is out of range');
  }
  const padding = plaintext.subarray(4 + length);
  if (padding.some((byte) => byte !== 0)) {
    throw new SealedFormatError('sealed padding is not zero');
  }
  return plaintext.subarray(4, 4 + length);
}

/** Seals items under a sender key; returns the `c` bytes of a SEALED body. */
export function sealItems(args: {
  wave: string;
  cls: number;
  gen: number;
  deviceKey: string;
  senderKey: Buffer;
  items: readonly SealedItem[];
  nonce?: Buffer;
}): Buffer {
  checkClassAndGeneration(args.cls, args.gen);
  if (!DEVICE_KEY.test(args.deviceKey)) {
    throw new SealedFormatError('device key must be 0x + 64 lowercase hex');
  }
  if (args.items.length === 0) {
    throw new SealedFormatError('nothing to seal');
  }
  const items = args.items.map(checkItem);
  const nonce = args.nonce ?? randomBytes(NONCE_BYTES);
  const header = Buffer.concat([
    Buffer.from([SealedFormat.ITEMS, args.cls]),
    u32(args.gen),
    Buffer.from(args.deviceKey.slice(2), 'hex'),
    nonce
  ]);
  const json = Buffer.from(canonicalizeJson({ items, v: 1 }), 'utf8');
  const cipher = createCipheriv(
    'aes-256-gcm',
    itemsKey(args.senderKey, args.wave, args.cls, args.gen),
    nonce
  );
  cipher.setAAD(itemsAad(args.wave, header));
  return Buffer.concat([
    header,
    cipher.update(pad(json)),
    cipher.final(),
    cipher.getAuthTag()
  ]);
}

export interface SealedItemsHeader {
  readonly cls: number;
  readonly gen: number;
  readonly deviceKey: string;
}

/** Reads the clear header of format 0x01 without opening it. */
export function readSealedItemsHeader(bytes: Buffer): SealedItemsHeader {
  if (
    bytes.length < ITEMS_HEADER_BYTES + TAG_BYTES ||
    bytes[0] !== SealedFormat.ITEMS
  ) {
    throw new SealedFormatError('not sealed items');
  }
  const cls = bytes[1];
  const gen = bytes.readUInt32BE(2);
  checkClassAndGeneration(cls, gen);
  return {
    cls,
    gen,
    deviceKey: `0x${bytes.subarray(6, 38).toString('hex')}`
  };
}

function parseItems(json: Buffer): SealedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw new SealedFormatError('sealed items are not JSON');
  }
  const doc = parsed as { items?: unknown; v?: unknown } | null;
  if (
    doc?.v !== 1 ||
    !Array.isArray(doc.items) ||
    doc.items.length === 0 ||
    Object.keys(doc).length !== 2 ||
    canonicalizeJson(parsed) !== json.toString('utf8')
  ) {
    throw new SealedFormatError(
      'sealed items must be canonical {"items","v":1}'
    );
  }
  return doc.items.map(checkItem);
}

export function openSealedItems(args: {
  wave: string;
  bytes: Buffer;
  senderKey: Buffer;
}): SealedItemsHeader & { readonly items: SealedItem[] } {
  const header = readSealedItemsHeader(args.bytes);
  const clearHeader = args.bytes.subarray(0, ITEMS_HEADER_BYTES);
  const nonce = clearHeader.subarray(ITEMS_HEADER_BYTES - NONCE_BYTES);
  const ct = args.bytes.subarray(ITEMS_HEADER_BYTES);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    itemsKey(args.senderKey, args.wave, header.cls, header.gen),
    nonce
  );
  decipher.setAAD(itemsAad(args.wave, clearHeader));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
      decipher.final()
    ]);
  } catch {
    throw new SealedFormatError('sealed items do not open with this key');
  }
  return { ...header, items: parseItems(unpad(plaintext)) };
}

// ---- Keys documents (format 0x02) and wraps ----

function wrapInfo(args: {
  wave: string;
  cls: number;
  gen: number;
  from: string;
  to: string;
}): Buffer {
  return Buffer.from(
    `${WRAP_INFO}|${args.wave}|${args.cls}|${args.gen}|${args.from}|${args.to}`,
    'utf8'
  );
}

export function wrapSenderKey(args: {
  wave: string;
  cls: number;
  gen: number;
  from: string;
  to: string;
  recipientPublicKey: Buffer;
  senderKey: Buffer;
  ephemeralPrivateKey?: Buffer;
}): KeyWrap {
  checkClassAndGeneration(args.cls, args.gen);
  const { enc, ct } = hpkeSealBase({
    recipientPublicKey: args.recipientPublicKey,
    info: wrapInfo(args),
    aad: EMPTY,
    plaintext: args.senderKey,
    ephemeralPrivateKey: args.ephemeralPrivateKey
  });
  return {
    cls: args.cls,
    gen: args.gen,
    from: args.from,
    to: args.to,
    enc: enc.toString('base64url'),
    ct: ct.toString('base64url')
  };
}

export function providerRecipient(provider: Pick<ProviderKey, 'id'>): string {
  return `svc:${provider.id}`;
}

export function unwrapSenderKey(args: {
  wave: string;
  wrap: KeyWrap;
  provider: ProviderKey;
}): Buffer {
  const { wrap } = args;
  if (wrap.to !== providerRecipient(args.provider)) {
    throw new SealedFormatError('wrap is addressed to another recipient');
  }
  const key = hpkeOpenBase({
    recipientPrivateKey: args.provider.privateKey,
    enc: Buffer.from(wrap.enc, 'base64url'),
    info: wrapInfo({ wave: args.wave, ...wrap }),
    aad: EMPTY,
    ct: Buffer.from(wrap.ct, 'base64url')
  });
  if (key.length !== KEY_BYTES) {
    throw new SealedFormatError('wrapped key is not 32 bytes');
  }
  return key;
}

function checkWrap(wrap: unknown): KeyWrap {
  const candidate = wrap as Partial<KeyWrap> | null;
  if (
    typeof candidate?.cls !== 'number' ||
    typeof candidate.gen !== 'number' ||
    typeof candidate.from !== 'string' ||
    !DEVICE_KEY.test(candidate.from) ||
    typeof candidate.to !== 'string' ||
    typeof candidate.enc !== 'string' ||
    typeof candidate.ct !== 'string' ||
    Object.keys(candidate).length !== 6
  ) {
    throw new SealedFormatError('malformed key wrap');
  }
  checkClassAndGeneration(candidate.cls, candidate.gen);
  return candidate as KeyWrap;
}

export function encodeKeysDocument(doc: KeysDocument): Buffer {
  return Buffer.concat([
    Buffer.from([SealedFormat.KEYS]),
    Buffer.from(canonicalizeJson(doc), 'utf8')
  ]);
}

export function decodeKeysDocument(bytes: Buffer): KeysDocument {
  if (bytes.length < 2 || bytes[0] !== SealedFormat.KEYS) {
    throw new SealedFormatError('not a keys document');
  }
  const text = bytes.subarray(1).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SealedFormatError('keys document is not JSON');
  }
  const doc = parsed as Partial<KeysDocument> | null;
  if (
    doc?.v !== 1 ||
    typeof doc.dev !== 'string' ||
    !DEVICE_KEY.test(doc.dev) ||
    !(
      doc.box === null ||
      (typeof doc.box === 'string' && DEVICE_KEY.test(doc.box))
    ) ||
    !Array.isArray(doc.wraps) ||
    Object.keys(doc).length !== 4 ||
    canonicalizeJson(parsed) !== text
  ) {
    throw new SealedFormatError('malformed keys document');
  }
  return { v: 1, dev: doc.dev, box: doc.box, wraps: doc.wraps.map(checkWrap) };
}

/**
 * Reads SIGNED_RECORDS_PROVIDER_KEYS: a JSON array of
 * {"id": "<key id>", "private_key": "0x<64 hex>"}. Unset means none.
 */
export function loadProviderKeys(raw: string | undefined): ProviderKey[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new SealedFormatError('provider keys must be a JSON array');
  }
  return parsed.map((entry: unknown) => {
    const { id, private_key: privateKeyHex } = (entry ?? {}) as {
      id?: unknown;
      private_key?: unknown;
    };
    if (
      typeof id !== 'string' ||
      !KEY_ID.test(id) ||
      typeof privateKeyHex !== 'string' ||
      !DEVICE_KEY.test(privateKeyHex)
    ) {
      throw new SealedFormatError('provider key must be {"id","private_key"}');
    }
    const privateKey = Buffer.from(privateKeyHex.slice(2), 'hex');
    return { id, privateKey, publicKey: x25519PublicKeyOf(privateKey) };
  });
}
