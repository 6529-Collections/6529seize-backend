import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

// Kept apart from the poster so the setup command can derive the key
// without loading the service's database and auth modules.

const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

/**
 * The Ed25519 key of a device seed (0x + 64 lowercase hex): the private key
 * and the public key as a grant names it (0x + 64 hex).
 */
export function deviceKeyOfSeed(seed: string): {
  readonly deviceKey: string;
  readonly privateKey: KeyObject;
} {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      Buffer.from(seed.slice(2), 'hex')
    ]),
    format: 'der',
    type: 'pkcs8'
  });
  const deviceKey = `0x${createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('hex')}`;
  return { deviceKey, privateKey };
}
