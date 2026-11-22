import {
  e2eeEd25519PublicKey,
  E2eeRecordGrantProof
} from '@/e2ee/relay/e2ee-record-event';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `E2EE_RELAY_MODE`, the switch of the delivery service's relay records:
 * - `off` (default, and anything unknown): no records, as today;
 * - `mirror`: every write also becomes a signed record, published to the
 *   relays after the commit (best effort; the publish loop catches up);
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
  readonly siteReader: E2eeRelayIdentity | null;
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
  if (mode === 'off') {
    return { mode, urls, net, quorum: 1, orderer: null, siteReader };
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
  const rawQuorum = Number(env.E2EE_RELAY_ACK_QUORUM ?? 1);
  const quorum =
    Number.isSafeInteger(rawQuorum) && rawQuorum >= 1
      ? Math.min(rawQuorum, urls.length)
      : 1;
  return { mode, urls, net, quorum, orderer, siteReader };
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
  'E2EE_SITE_READER_KEY',
  'E2EE_SITE_READER_GRANT'
];

/** The settings from `process.env`, parsed once per distinct value set. */
export function e2eeRelaySettings(): E2eeRelaySettings {
  const key = JSON.stringify(SETTINGS_ENV.map((name) => process.env[name]));
  if (cached?.key !== key) {
    cached = { key, settings: readE2eeRelaySettings(process.env) };
  }
  return cached.settings;
}
