import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import {
  KeyWrap,
  ProviderKey,
  providerRecipient,
  SealedClass,
  unwrapSenderKey,
  wrapSenderKey
} from '@/signed-records/sealed-crypto';

/**
 * Record content sealed to 6529.io's moderation service key. Reports
 * are the moderators' to read, so their records go to the relays sealed: a
 * relay, or anyone who copies a relay's store, sees only ciphertext.
 *
 *   0x10 | version u8 (2) | wrap length u32be | wrap JSON | nonce (12)
 *        | AES-256-GCM(record content, version 1) | tag (16)
 *
 * Each record has its own random key K. The wrap is the personal module's
 * HPKE key wrap of K to the moderation key (`svc:<id>`, class PROVIDER,
 * generation 1, from the orderer's device key), canonical JSON. The AAD is
 * the label, the stream and everything before the nonce, so a sealed record
 * cannot be moved to another stream or given another wrap. The hash chain
 * covers the sealed bytes: what the relays hold is what the next record
 * names.
 */
const RECORD_CONTENT_TAG = 0x10;
export const E2EE_SEALED_CONTENT_VERSION = 2;
const PREFIX = 6;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD_LABEL = '6529.io e2ee sealed record';
const KEY_ID = /^[a-z0-9-]{1,32}$/;
const HEX_KEY = /^0x[0-9a-f]{64}$/;

/** The moderators' inbox: the one `md` stream that holds 6529.io's reports. */
export const E2EE_MODERATION_INBOX = `0x${createHash('sha256')
  .update('6529.io moderation inbox')
  .digest('hex')}`;

/** The moderation service key a record is sealed to: its id and X25519 key. */
export interface E2eeSealRecipient {
  readonly id: string;
  readonly publicKey: Buffer;
}

export class E2eeSealedContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeSealedContentError';
    Object.setPrototypeOf(this, E2eeSealedContentError.prototype);
  }
}

function aad(wave: string, header: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${AAD_LABEL}|${wave}`, 'utf8'), header]);
}

/** Seals record content (version 1) for the stream `wave`. */
export function sealE2eeRecordContent(args: {
  readonly content: Buffer;
  readonly wave: string;
  /** The orderer's device key, 0x and 64 lowercase hex digits. */
  readonly from: string;
  readonly to: E2eeSealRecipient;
  readonly key?: Buffer;
  readonly nonce?: Buffer;
  readonly ephemeralPrivateKey?: Buffer;
}): Buffer {
  if (args.content[0] !== RECORD_CONTENT_TAG || args.content[1] !== 1) {
    throw new E2eeSealedContentError('Only version 1 content is sealed');
  }
  const key = args.key ?? randomBytes(KEY_BYTES);
  const wrap = wrapSenderKey({
    wave: args.wave,
    cls: SealedClass.PROVIDER,
    gen: 1,
    from: args.from,
    to: providerRecipient(args.to),
    recipientPublicKey: args.to.publicKey,
    senderKey: key,
    ephemeralPrivateKey: args.ephemeralPrivateKey
  });
  const wrapJson = Buffer.from(canonicalizeJson(wrap), 'utf8');
  const prefix = Buffer.alloc(PREFIX);
  prefix[0] = RECORD_CONTENT_TAG;
  prefix[1] = E2EE_SEALED_CONTENT_VERSION;
  prefix.writeUInt32BE(wrapJson.length, 2);
  const header = Buffer.concat([prefix, wrapJson]);
  const nonce = args.nonce ?? randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(args.wave, header));
  return Buffer.concat([
    header,
    nonce,
    cipher.update(args.content),
    cipher.final(),
    cipher.getAuthTag()
  ]);
}

export function isSealedE2eeRecordContent(bytes: Buffer): boolean {
  return (
    bytes.length >= PREFIX &&
    bytes[0] === RECORD_CONTENT_TAG &&
    bytes[1] === E2EE_SEALED_CONTENT_VERSION
  );
}

function readWrap(bytes: Buffer): { wrap: KeyWrap; headerEnd: number } {
  if (!isSealedE2eeRecordContent(bytes)) {
    throw new E2eeSealedContentError('Not sealed record content');
  }
  const headerEnd = PREFIX + bytes.readUInt32BE(2);
  if (headerEnd + NONCE_BYTES + TAG_BYTES > bytes.length) {
    throw new E2eeSealedContentError('Sealed content is cut short');
  }
  let wrap: Partial<KeyWrap>;
  try {
    wrap = JSON.parse(bytes.subarray(PREFIX, headerEnd).toString('utf8'));
  } catch {
    throw new E2eeSealedContentError('The key wrap is not JSON');
  }
  if (
    typeof wrap?.to !== 'string' ||
    typeof wrap.from !== 'string' ||
    typeof wrap.enc !== 'string' ||
    typeof wrap.ct !== 'string' ||
    wrap.cls !== SealedClass.PROVIDER ||
    wrap.gen !== 1
  ) {
    throw new E2eeSealedContentError('Malformed key wrap');
  }
  return { wrap: wrap as KeyWrap, headerEnd };
}

/** Who sealed content is for (`svc:<id>`), without opening it. */
export function sealedE2eeRecordRecipient(bytes: Buffer): string {
  return readWrap(bytes).wrap.to;
}

/** Opens sealed content with whichever of `keys` it is sealed to. */
export function openE2eeRecordContent(args: {
  readonly bytes: Buffer;
  readonly wave: string;
  readonly keys: readonly ProviderKey[];
}): Buffer {
  const { wrap, headerEnd } = readWrap(args.bytes);
  const provider = args.keys.find((key) => providerRecipient(key) === wrap.to);
  if (!provider) {
    throw new E2eeSealedContentError(
      `Sealed to ${wrap.to}, a key this reader does not hold`
    );
  }
  try {
    const key = unwrapSenderKey({ wave: args.wave, wrap, provider });
    const nonce = args.bytes.subarray(headerEnd, headerEnd + NONCE_BYTES);
    const sealed = args.bytes.subarray(headerEnd + NONCE_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(args.wave, args.bytes.subarray(0, headerEnd)));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final()
    ]);
  } catch {
    throw new E2eeSealedContentError(
      `Sealed content does not open with ${wrap.to}`
    );
  }
}

/**
 * Reads `E2EE_MODERATION_PUBLIC_KEY`: `{"id": "<key id>", "public_key":
 * "0x<64 hex>"}`, the moderation service's X25519 public key.
 */
export function parseE2eeModerationKey(raw: string): E2eeSealRecipient {
  let value: { id?: unknown; public_key?: unknown };
  try {
    value = JSON.parse(raw);
  } catch {
    throw new E2eeSealedContentError('E2EE_MODERATION_PUBLIC_KEY is not JSON');
  }
  const publicKey =
    typeof value?.public_key === 'string' ? value.public_key.toLowerCase() : '';
  if (
    typeof value?.id !== 'string' ||
    !KEY_ID.test(value.id) ||
    !HEX_KEY.test(publicKey)
  ) {
    throw new E2eeSealedContentError(
      'E2EE_MODERATION_PUBLIC_KEY must be {"id","public_key"}'
    );
  }
  return { id: value.id, publicKey: Buffer.from(publicKey.slice(2), 'hex') };
}
