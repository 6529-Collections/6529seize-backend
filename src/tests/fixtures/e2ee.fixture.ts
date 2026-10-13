import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomBytes,
  sign
} from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

export interface E2eeTestKey {
  /** Raw Ed25519 public key, 0x + 64 lowercase hex. */
  readonly publicKey: string;
  /** Ed25519 signature over the 32 raw bytes of a 0x digest; 0x + 128 hex. */
  sign(digest: string): string;
}

function toTestKey(privateKey: KeyObject): E2eeTestKey {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = `0x${Buffer.from(jwk.x!, 'base64url').toString('hex')}`;
  return {
    publicKey,
    sign(digest: string): string {
      const message = Buffer.from(digest.slice(2), 'hex');
      return `0x${sign(null, message, privateKey).toString('hex')}`;
    }
  };
}

/** Deterministic Ed25519 key from a 32-byte seed (RFC 8032). */
export function e2eeKeyFromSeed(seedHex: string): E2eeTestKey {
  const seed = Buffer.from(seedHex.replace(/^0x/, ''), 'hex');
  if (seed.length !== 32) throw new Error('Seed must be 32 bytes');
  return toTestKey(
    createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8'
    })
  );
}

export function randomE2eeKey(): E2eeTestKey {
  return e2eeKeyFromSeed(randomBytes(32).toString('hex'));
}

export function randomE2eeGroupHandle(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}
