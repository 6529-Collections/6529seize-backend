import {
  E2eeSealRecipient,
  parseE2eeModerationKey
} from '@/e2ee/relay/e2ee-moderation-seal';
import {
  e2eeEd25519PublicKey,
  E2eeRecordGrantProof
} from '@/e2ee/relay/e2ee-record-event';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `E2EE_RELAY_MODE`, the switch of the delivery service's relay records:
 * - `off` (default, and anything unknown): no records, as today;
 * - `mirror`: every write also becomes a signed record, published to the
 *   relays after the commit (best effort; later writes catch up);
 * - `primary`: a write commits only after at least `E2EE_RELAY_ACK_QUORUM`
 *   relays hold its records.
 * Rollback from `primary` is one change: `mirror`.
 */
export type E2eeRelayMode = 'off' | 'mirror' | 'primary';

export function e2eeRelayMode(env: Env = process.env): E2eeRelayMode {
  const value = env.E2EE_RELAY_MODE?.trim().toLowerCase();
  return value === 'mirror' || value === 'primary' ? value : 'off';
}

/** A device key and its grant: the orderer's, or the site-reader's. */
export interface E2eeRelayIdentity {
  readonly seed: Buffer;
  readonly deviceKey: string;
  readonly grant: E2eeRecordGrantProof;
}

export interface E2eeRelaySettings {
  readonly mode: E2eeRelayMode;
  readonly urls: readonly string[];
  readonly net: string;
  readonly quorum: number;
  readonly orderer: E2eeRelayIdentity | null;
  /**
   * The orderer's public key, the only key whose records a rebuild accepts:
   * the configured orderer's, or `E2EE_ORDERER_PUBLIC_KEY` where only a
   * reader runs (the rebuild and the side-by-side check).
   */
  readonly ordererPublicKey: string | null;
  readonly siteReader: E2eeRelayIdentity | null;
  /** The moderation service key report records are sealed to. */
  readonly moderation: E2eeSealRecipient | null;
  /** Its private keys: only a rebuild or check of reports holds them. */
  readonly moderationKeys: readonly ProviderKey[];
}

export class E2eeRelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeRelayConfigError';
    Object.setPrototypeOf(this, E2eeRelayConfigError.prototype);
  }
}

const HEX_32 = /^(0x)?[0-9a-fA-F]{64}$/;

function parseGrant(raw: string, name: string): E2eeRecordGrantProof {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new E2eeRelayConfigError(`${name} is not JSON`);
  }
  const text = (field: string) => {
    const found = value[field];
    if (typeof found !== 'string' || !found) {
      throw new E2eeRelayConfigError(`${name}.${field} is missing`);
    }
    return found;
  };
  const scopes = value.scopes;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    throw new E2eeRelayConfigError(`${name}.scopes is missing`);
  }
  if (!scopes.includes('post')) {
    throw new E2eeRelayConfigError(`${name} lacks the post scope`);
  }
  const expiresAt = Number(value.expires_at);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new E2eeRelayConfigError(`${name}.expires_at is missing`);
  }
  return {
    id: text('id').toLowerCase(),
    message: text('message'),
    wallet_signature: text('wallet_signature'),
    chain_id: Number(value.chain_id ?? 1),
    wallet: text('wallet').toLowerCase(),
    device_key: text('device_key').toLowerCase(),
    scopes,
    domain: text('domain'),
    expires_at: expiresAt,
    revoked_at:
      value.revoked_at === null || value.revoked_at === undefined
        ? null
        : Number(value.revoked_at)
  };
}

function parseIdentity(
  env: Env,
  keyName: string,
  grantName: string
): E2eeRelayIdentity | null {
  const key = env[keyName]?.trim();
  const grantRaw = env[grantName]?.trim();
  if (!key && !grantRaw) return null;
  if (!key || !HEX_32.test(key)) {
    throw new E2eeRelayConfigError(`${keyName} must be a 32-byte hex seed`);
  }
  if (!grantRaw) throw new E2eeRelayConfigError(`${grantName} is missing`);
  const seed = Buffer.from(key.replace(/^0x/, ''), 'hex');
  const deviceKey = e2eeEd25519PublicKey(seed);
  const grant = parseGrant(grantRaw, grantName);
  if (grant.device_key !== deviceKey) {
    throw new E2eeRelayConfigError(
      `${grantName} names device key ${grant.device_key}, not ${keyName}'s ${deviceKey}`
    );
  }
  return { seed, deviceKey, grant };
}

function parseModeration(env: Env): {
  readonly moderation: E2eeSealRecipient | null;
  readonly moderationKeys: readonly ProviderKey[];
} {
  const raw = env.E2EE_MODERATION_PUBLIC_KEY?.trim();
  let moderation: E2eeSealRecipient | null = null;
  let moderationKeys: ProviderKey[] = [];
  try {
    moderation = raw ? parseE2eeModerationKey(raw) : null;
    moderationKeys = loadProviderKeys(env.E2EE_MODERATION_KEYS);
  } catch (error) {
    throw new E2eeRelayConfigError((error as Error).message);
  }
  const pair = moderationKeys.find((key) => key.id === moderation?.id);
  if (moderation && pair && !pair.publicKey.equals(moderation.publicKey)) {
    throw new E2eeRelayConfigError(
      `E2EE_MODERATION_KEYS holds another key for ${moderation.id}`
    );
  }
  return { moderation, moderationKeys };
}

/**
 * Reads the relay settings. With the mode off nothing else is read. Any
 * other mode needs the relay URLs, the network tag and the orderer's key and
 * grant; a missing or wrong value throws, so a bad deploy fails loudly
 * instead of writing records nobody can check.
 *
 * - `E2EE_RELAY_URLS`: comma-separated `wss://` URLs.
 * - `E2EE_RELAY_NET`: the CRP network tag, e.g. `6529-interim-prod`.
 * - `E2EE_RELAY_ACK_QUORUM`: relays that must hold a record before a
 *   `primary` write commits (default 1, at most the number of relays).
 * - `E2EE_ORDERER_KEY` and `E2EE_ORDERER_GRANT`: the orderer's Ed25519
 *   seed (secret) and its grant proof (JSON, CRP's GrantProof).
 * - `E2EE_SITE_READER_KEY` and `E2EE_SITE_READER_GRANT`: the site-reader's,
 *   for the rebuild and the side-by-side check (optional otherwise).
 * - `E2EE_MODERATION_PUBLIC_KEY`: `{"id", "public_key"}`, the moderation
 *   service's X25519 key that report records are sealed to (required with
 *   records on). `E2EE_MODERATION_KEYS` (secret): its private keys as
 *   `[{"id", "private_key"}]`, only where reports are rebuilt or checked.
 */
export function readE2eeRelaySettings(
  env: Env = process.env
): E2eeRelaySettings {
  const mode = e2eeRelayMode(env);
  const siteReader = parseIdentity(
    env,
    'E2EE_SITE_READER_KEY',
    'E2EE_SITE_READER_GRANT'
  );
  const urls = (env.E2EE_RELAY_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const net = env.E2EE_RELAY_NET?.trim() ?? '';
  const pinned = env.E2EE_ORDERER_PUBLIC_KEY?.trim().toLowerCase() || null;
  if (pinned !== null && !/^0x[0-9a-f]{64}$/.test(pinned)) {
    throw new E2eeRelayConfigError(
      'E2EE_ORDERER_PUBLIC_KEY must be 0x and 32 bytes of hex'
    );
  }
  const { moderation, moderationKeys } = parseModeration(env);
  if (mode === 'off') {
    return {
      mode,
      urls,
      net,
      quorum: 1,
      orderer: null,
      ordererPublicKey: pinned,
      siteReader,
      moderation,
      moderationKeys
    };
  }
  if (!urls.length) {
    throw new E2eeRelayConfigError('E2EE_RELAY_URLS is empty');
  }
  const bad = urls.find((url) => !/^wss?:\/\//.test(url));
  if (bad) throw new E2eeRelayConfigError(`Not a WebSocket URL: ${bad}`);
  if (!net) throw new E2eeRelayConfigError('E2EE_RELAY_NET is missing');
  const orderer = parseIdentity(env, 'E2EE_ORDERER_KEY', 'E2EE_ORDERER_GRANT');
  if (!orderer) {
    throw new E2eeRelayConfigError('E2EE_ORDERER_KEY is missing');
  }
  if (!moderation) {
    throw new E2eeRelayConfigError('E2EE_MODERATION_PUBLIC_KEY is missing');
  }
  if (pinned !== null && pinned !== orderer.deviceKey) {
    throw new E2eeRelayConfigError(
      'E2EE_ORDERER_PUBLIC_KEY is not the configured orderer key'
    );
  }
  const rawQuorum = Number(env.E2EE_RELAY_ACK_QUORUM ?? 1);
  const quorum =
    Number.isSafeInteger(rawQuorum) && rawQuorum >= 1
      ? Math.min(rawQuorum, urls.length)
      : 1;
  return {
    mode,
    urls,
    net,
    quorum,
    orderer,
    ordererPublicKey: orderer.deviceKey,
    siteReader,
    moderation,
    moderationKeys
  };
}

let cached: {
  readonly key: string;
  readonly settings: E2eeRelaySettings;
} | null = null;

const SETTINGS_ENV = [
  'E2EE_RELAY_MODE',
  'E2EE_RELAY_URLS',
  'E2EE_RELAY_NET',
  'E2EE_RELAY_ACK_QUORUM',
  'E2EE_ORDERER_KEY',
  'E2EE_ORDERER_GRANT',
  'E2EE_ORDERER_PUBLIC_KEY',
  'E2EE_SITE_READER_KEY',
  'E2EE_SITE_READER_GRANT',
  'E2EE_MODERATION_PUBLIC_KEY',
  'E2EE_MODERATION_KEYS'
];

/** The settings from `process.env`, parsed once per distinct value set. */
export function e2eeRelaySettings(): E2eeRelaySettings {
  const key = JSON.stringify(SETTINGS_ENV.map((name) => process.env[name]));
  if (cached?.key !== key) {
    cached = { key, settings: readE2eeRelaySettings(process.env) };
  }
  return cached.settings;
}
