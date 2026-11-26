import { createHash } from 'node:crypto';

/**
 * Content identifiers for profile site files named by a ProfileDoc's `cms`
 * field: CIDv1, codec raw (0x55), multihash sha2-256, written in lower-case
 * base32 with the `b` multibase prefix. The digest is the SHA-256 of the file's
 * bytes, so it maps one to one onto a CMS `sha256:<hex>` hash.
 */
const CID_PREFIX = Buffer.from([0x01, 0x55, 0x12, 0x20]);
const CID_BYTES = CID_PREFIX.length + 32;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const CMS_HASH_PATTERN = /^sha256:([a-f0-9]{64})$/;
const CID_TEXT_PATTERN = /^b[a-z2-7]+$/;

export function cmsCidFromBytes(bytes: Buffer): string {
  return cmsCidFromDigest(createHash('sha256').update(bytes).digest());
}

export function cmsCidFromHash(hash: string): string {
  const match = CMS_HASH_PATTERN.exec(hash);
  if (!match) {
    throw new Error(`Not a CMS sha256 hash: ${hash}`);
  }
  return cmsCidFromDigest(Buffer.from(match[1], 'hex'));
}

/** The CMS `sha256:<hex>` hash a CID names, or null when it is not a raw sha2-256 CIDv1. */
export function cmsHashFromCid(cid: string): string | null {
  const binary = cmsCidToBinary(cid);
  return binary
    ? `sha256:${binary.subarray(CID_PREFIX.length).toString('hex')}`
    : null;
}

export function isCmsCid(value: unknown): value is string {
  return typeof value === 'string' && cmsCidToBinary(value) !== null;
}

export function cmsCidMatchesBytes(cid: string, bytes: Buffer): boolean {
  return cmsCidFromBytes(bytes) === cid;
}

function cmsCidFromDigest(digest: Buffer): string {
  return `b${toBase32(Buffer.concat([CID_PREFIX, digest]))}`;
}

function cmsCidToBinary(cid: string): Buffer | null {
  if (!CID_TEXT_PATTERN.test(cid)) {
    return null;
  }
  const binary = fromBase32(cid.slice(1));
  if (
    !binary ||
    binary.length !== CID_BYTES ||
    !binary.subarray(0, CID_PREFIX.length).equals(CID_PREFIX)
  ) {
    return null;
  }
  // Reject non-canonical text: the same bytes must encode back to this string.
  return cmsCidFromDigest(binary.subarray(CID_PREFIX.length)) === cid
    ? binary
    : null;
}

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let index = 0; index < bytes.length; index++) {
    value = (value << 8) | bytes[index];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function fromBase32(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
