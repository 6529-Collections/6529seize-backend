import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign
} from 'node:crypto';
import { TypedDataEncoder } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  AppDeviceGrantTypedDataMessage
} from './app-device-grant';
import {
  computeGrantExpiresAtSeconds,
  DEFAULT_DEVICE_GRANT_SCOPES,
  DeviceGrantScope
} from './device-grant-message';

// Device keys of 6529.io's own bots. A bot signs its drop writes with an
// Ed25519 device key under an app device grant (EIP-712, signing only) that
// the bot's wallet signed once, offline, with `6529 run waves:bot-device-grant`.
// Its drops then verify like any author's and reach the 6529 relays. The
// backend holds the device key and the signed grant, never the wallet key.

/** The setting that holds the bots' keys (env or the lambdas secret). */
export const BOT_DEVICE_KEYS_SETTING = 'WAVES_BOT_DEVICE_KEYS';

/**
 * Where a bot grant says it was signed. The 6529.io servers hold the device
 * key, and readers recognise this origin, so the bot's drops show as signed.
 */
export const BOT_GRANT_ORIGIN = '6529.io';

/** One bot's entry in WAVES_BOT_DEVICE_KEYS, keyed by the bot's profile id. */
export interface BotDeviceKeyEntry {
  /** The Ed25519 private key's 32-byte seed: 0x and 64 lowercase hex digits. */
  readonly device_seed: string;
  /** The grant the wallet signed, as JSON text (as device_grants stores it). */
  readonly grant_message: string;
  /** The wallet's EIP-712 signature over the grant. */
  readonly grant_signature: string;
}

// PKCS#8 DER of an Ed25519 private key, up to its 32-byte seed.
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);
const SEED_PATTERN = /^0x[0-9a-f]{64}$/;
const SEED_BYTES = 32;

export function ed25519PrivateKeyFromSeed(seed: string): KeyObject {
  if (!SEED_PATTERN.test(seed)) {
    throw new Error('A device seed is 0x and 64 lowercase hex digits');
  }
  return createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      Buffer.from(seed.slice(2), 'hex')
    ]),
    format: 'der',
    type: 'pkcs8'
  });
}

/** The raw public key as 0x and 64 lowercase hex digits. */
export function ed25519PublicKeyOf(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki'
  });
  return `0x${spki.subarray(spki.length - SEED_BYTES).toString('hex')}`;
}

export function newEd25519Seed(): string {
  const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({
    format: 'der',
    type: 'pkcs8'
  });
  return `0x${pkcs8.subarray(pkcs8.length - SEED_BYTES).toString('hex')}`;
}

/** The Ed25519 signature over an event id, as a signed write carries it. */
export function signEventId(privateKey: KeyObject, eventId: string): string {
  const signature = sign(
    null,
    Buffer.from(eventId.slice(2), 'hex'),
    privateKey
  );
  return `0x${signature.toString('hex')}`;
}

/** The grant a bot's wallet signs: signing only, for 180 days. */
export function buildBotDeviceGrant({
  wallet,
  deviceKey,
  issuedAt,
  scopes = DEFAULT_DEVICE_GRANT_SCOPES,
  origin = BOT_GRANT_ORIGIN
}: {
  readonly wallet: string;
  readonly deviceKey: string;
  readonly issuedAt: Date;
  readonly scopes?: readonly DeviceGrantScope[];
  readonly origin?: string;
}): AppDeviceGrant {
  return {
    version: 2,
    wallet: wallet.toLowerCase(),
    device_key: deviceKey,
    scopes: [...scopes],
    mls_device_key: null,
    ciphersuite: null,
    ciphersuites: [],
    issued_at: Math.floor(issuedAt.getTime() / 1000),
    expires_at: computeGrantExpiresAtSeconds(issuedAt),
    origin
  };
}

/** The grant as typed data for any wallet (eth_signTypedData_v4). */
export function botDeviceGrantTypedData(
  message: AppDeviceGrantTypedDataMessage
): unknown {
  return TypedDataEncoder.getPayload(
    APP_DEVICE_GRANT_DOMAIN_V2,
    APP_DEVICE_GRANT_TYPES_V2,
    message
  );
}
