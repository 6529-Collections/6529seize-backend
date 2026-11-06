import { createHash } from 'crypto';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** CIDv1 header: version 1, codec raw (0x55), multihash sha2-256 (0x12), 32 bytes. */
const CID_V1_RAW_SHA256_PREFIX = [0x01, 0x55, 0x12, 0x20];

/** Largest file that IPFS stores as one raw block. */
export const MAX_SINGLE_BLOCK_BYTES = 1024 * 1024;

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** RFC 4648 base32, lower case, no padding (multibase `b`). */
function base32Lower(bytes: ReadonlyArray<number>): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

/**
 * The IPFS CIDv1 of a file stored as a single raw block
 * (`ipfs add --cid-version=1 --raw-leaves`, file at most 1 MiB). It is a
 * re-encoding of the file's sha256, so anyone can compute it offline.
 */
export function rawBlockCid(bytes: Buffer): string {
  if (bytes.length > MAX_SINGLE_BLOCK_BYTES) {
    throw new Error(
      `File is ${bytes.length} bytes; a single raw IPFS block holds at most ${MAX_SINGLE_BLOCK_BYTES}`
    );
  }
  const digest = createHash('sha256').update(bytes).digest();
  const cidBytes: number[] = CID_V1_RAW_SHA256_PREFIX.slice();
  for (let i = 0; i < digest.length; i++) {
    cidBytes.push(digest[i]);
  }
  return `b${base32Lower(cidBytes)}`;
}
