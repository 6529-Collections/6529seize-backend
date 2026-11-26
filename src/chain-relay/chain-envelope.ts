/**
 * The start of a 6529 chain transaction's wire bytes, as the chain's
 * transaction format and its canonical encoding lay them out: schemaId
 * 0x4001 and version 1, NETWORK_ID, the header's fields 1-15, then opType
 * and opVersion. The relay reads who signs and which operation it is
 * from here. The chain decodes and checks the whole transaction again.
 */
export interface EnvelopeHead {
  readonly networkId: string;
  readonly ruleVersion: number;
  /** Zero for an operation without a principal. */
  readonly principal: string;
  readonly keyType: number;
  readonly keyId: string;
  /** The grant a session key signs under; null when absent. */
  readonly authRef: string | null;
  readonly opType: number;
  readonly opVersion: number;
}

const SCHEMA_SIGNED_TX = 0x4001;
const SCHEMA_VERSION = 1;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})+$/;

class Cursor {
  private at = 0;

  constructor(private readonly bytes: Buffer) {}

  take(count: number): Buffer {
    if (this.at + count > this.bytes.length) {
      throw new RangeError('the bytes end early');
    }
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    return this.take(2).readUInt16BE(0);
  }

  u32(): number {
    return this.take(4).readUInt32BE(0);
  }

  word(): string {
    return '0x' + this.take(32).toString('hex');
  }

  /** A CE optional: 0 when absent, else 1 and a value that is not all zero. */
  optional(count: number): Buffer | null {
    const flag = this.u8();
    if (flag === 0) return null;
    const value = flag === 1 ? this.take(count) : null;
    if (!value || value.every((byte) => byte === 0)) {
      throw new RangeError('a malformed optional field');
    }
    return value;
  }
}

/**
 * The envelope head of a transaction's `unsigned` or `signed` bytes (0x hex),
 * or null when the bytes are not a SignedTx v1.
 */
export function readEnvelopeHead(hex: string): EnvelopeHead | null {
  const value = hex.trim().toLowerCase();
  if (!HEX_BYTES.test(value)) return null;
  const r = new Cursor(Buffer.from(value.slice(2), 'hex'));
  try {
    if (r.u16() !== SCHEMA_SIGNED_TX || r.u16() !== SCHEMA_VERSION) {
      return null;
    }
    const networkId = r.word();
    const ruleVersion = r.u32();
    const principal = r.word();
    const keyType = r.u8();
    const keyId = r.word();
    const authRef = r.optional(32);
    r.take(4 + 8 + 8 + 8); // nonceLane, nonce, notBefore, expiresAt
    r.optional(8 + 32); // ethRef
    r.take(1); // feeMode
    r.optional(32); // sponsorRef
    r.take(16 + 8 + 16); // maxFee, maxWork, tipPerRU
    const opType = r.u16();
    const opVersion = r.u16();
    return {
      networkId,
      ruleVersion,
      principal,
      keyType,
      keyId,
      authRef: authRef ? '0x' + authRef.toString('hex') : null,
      opType,
      opVersion
    };
  } catch {
    return null;
  }
}

/** One entry of a transaction's signature list, its proof empty. */
export interface EnvelopeSignature {
  readonly role: number;
  readonly keyType: number;
  readonly sig: string;
}

/** CE bytes of a signature list of these signatures with empty proofs. */
export function signatureListBytes(sigBytes: readonly number[]): number {
  return 4 + sigBytes.reduce((sum, it) => sum + 1 + 1 + 4 + it + 4, 0);
}

/**
 * Splits a signed transaction whose signature list is one entry with a
 * `sigBytes`-byte signature and an empty proof: a wallet's (65 bytes) or a
 * session key's (64) single signature. A body's length depends on its
 * operation's schema, so the list is read from the end: count 1, role,
 * keyType, the signature's length, the signature, proof length 0. Null when
 * the bytes don't end that way, so a longer list or anything after the list
 * is refused.
 */
export function splitSingleSignature(
  signedHex: string,
  sigBytes: number
): { unsigned: string; signature: EnvelopeSignature } | null {
  const value = signedHex.trim().toLowerCase();
  if (!HEX_BYTES.test(value)) return null;
  const bytes = Buffer.from(value.slice(2), 'hex');
  const listBytes = signatureListBytes([sigBytes]);
  if (bytes.length <= listBytes) return null;
  const r = new Cursor(bytes.subarray(bytes.length - listBytes));
  if (r.u32() !== 1) return null;
  const role = r.u8();
  const keyType = r.u8();
  if (r.u32() !== sigBytes) return null;
  const sig = '0x' + r.take(sigBytes).toString('hex');
  if (r.u32() !== 0) return null;
  return {
    unsigned:
      '0x' + bytes.subarray(0, bytes.length - listBytes).toString('hex'),
    signature: { role, keyType, sig }
  };
}
