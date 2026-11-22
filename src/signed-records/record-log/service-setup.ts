import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  recoversToAppGrantWallet
} from '@/api/device-signing/app-device-grant';
import { GRANT_TTL_SECONDS } from '@/api/device-signing/device-grant-message';
import { loadProviderKeys } from '../sealed-crypto';
import { deviceKeyOfSeed } from './service-device-key';

/**
 * Setup of the records service identity, run by whoever holds its keys on
 * their own machine (service-setup.cli.ts): new keys into a local file, a
 * device grant for the device key signed by the service wallet, its
 * renewal, and revocation. Secrets stay in the file; errors never quote it.
 */

export const SETUP_ENVIRONMENTS = ['staging', 'production'] as const;
export type SetupEnvironment = (typeof SETUP_ENVIRONMENTS)[number];

/** An environment's API, and the web origin its grants name. */
export interface SetupApi {
  readonly base: string;
  readonly origin: string;
}

/**
 * Fixed here, never read from the shell's environment: the pairing of each
 * API host with its web origin that the server itself uses by default
 * (web-app-origins.ts), which the tests check.
 */
export const SETUP_APIS: Readonly<Record<SetupEnvironment, SetupApi>> = {
  staging: {
    base: 'https://api.staging.6529.io/api',
    origin: 'staging.6529.io'
  },
  production: { base: 'https://api.6529.io/api', origin: '6529.io' }
};

export const SERVICE_DEVICE_LABEL = 'Signed records service';

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface ServiceKeysFile {
  readonly environment: SetupEnvironment;
  readonly created_at: string;
  /** Secret. The first goes nowhere; the other two go into the config secret. */
  readonly secret: {
    readonly service_wallet_private_key: string;
    readonly SIGNED_RECORDS_SERVICE_DEVICE_SEED: string;
    readonly SIGNED_RECORDS_PROVIDER_KEYS: string;
  };
  /** Not secret. The grant fields appear once a grant is registered. */
  readonly public: ServiceKeysPublic;
}

export interface ServiceKeysPublic {
  readonly SIGNED_RECORDS_SERVICE_WALLET: string;
  readonly device_key: string;
  readonly provider_public_keys: readonly {
    readonly id: string;
    readonly public_key: string;
  }[];
  readonly api?: string;
  readonly SIGNED_RECORDS_SERVICE_PROFILE_ID?: string;
  readonly SIGNED_RECORDS_SERVICE_GRANT_ID?: string;
  readonly grant_expires_at?: string;
  /** Earlier grants of this file, renewed or replaced. */
  readonly previous_grant_ids?: readonly string[];
  /** Grants this file's commands revoked. */
  readonly revoked_grant_ids?: readonly string[];
}

/** A grant as GET /device-grants lists it; times in epoch milliseconds. */
export interface ServiceGrant {
  readonly id: string;
  readonly device_key: string;
  readonly device_label: string | null;
  readonly created_at: number;
  readonly expires_at: number;
  readonly revoked_at: number | null;
}

type Random = (size: number) => Buffer;

const hex = (bytes: Buffer) => `0x${bytes.toString('hex')}`;
const isHex32 = (value: unknown): value is string =>
  typeof value === 'string' && HEX32.test(value);

/** A new service wallet, device seed and provider key for one environment. */
export function createServiceKeys(
  environment: SetupEnvironment,
  now: Date = new Date(),
  random: Random = randomBytes
): ServiceKeysFile {
  const wallet = new Wallet(hex(random(32)));
  const seed = hex(random(32));
  // To the second, so keys made on the same day get different ids.
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const providerKeys = JSON.stringify([
    { id: `${environment}-${stamp}`, private_key: hex(random(32)) }
  ]);
  // Read back with the loaders the service uses, so the formats match.
  const providers = loadProviderKeys(providerKeys);
  return {
    environment,
    created_at: now.toISOString(),
    secret: {
      service_wallet_private_key: wallet.privateKey,
      SIGNED_RECORDS_SERVICE_DEVICE_SEED: seed,
      SIGNED_RECORDS_PROVIDER_KEYS: providerKeys
    },
    public: {
      SIGNED_RECORDS_SERVICE_WALLET: wallet.address.toLowerCase(),
      device_key: deviceKeyOfSeed(seed).deviceKey,
      provider_public_keys: providers.map((provider) => ({
        id: provider.id,
        public_key: hex(provider.publicKey)
      }))
    }
  };
}

/** The service wallet and device key, checked against the public values. */
function serviceKeysOf(keys: ServiceKeysFile) {
  let signer: Wallet;
  try {
    signer = new Wallet(keys.secret.service_wallet_private_key);
  } catch {
    throw new Error('The service wallet key in the keys file is not usable');
  }
  const wallet = signer.address.toLowerCase();
  const { deviceKey } = deviceKeyOfSeed(
    keys.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED
  );
  if (
    wallet !== keys.public.SIGNED_RECORDS_SERVICE_WALLET ||
    deviceKey !== keys.public.device_key
  ) {
    throw new Error('The keys file does not match its own public values');
  }
  return { signer, wallet, deviceKey };
}

/**
 * Reads a keys file. Every message is fixed: the file holds secrets, and a
 * parser's or a wallet library's message could quote them.
 */
export function parseKeysFile(text: string): ServiceKeysFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The keys file is not valid JSON');
  }
  const file = parsed as Partial<ServiceKeysFile> | null;
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.secret !== 'object' ||
    file.secret === null ||
    typeof file.public !== 'object' ||
    file.public === null
  ) {
    throw new Error('The file is not a records service keys file');
  }
  if (SETUP_ENVIRONMENTS.indexOf(file.environment as SetupEnvironment) < 0) {
    throw new Error('The keys file names no known environment');
  }
  if (
    !isHex32(file.secret.service_wallet_private_key) ||
    !isHex32(file.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED)
  ) {
    throw new Error('A secret in the keys file is malformed');
  }
  let providerCount = 0;
  try {
    providerCount = loadProviderKeys(
      file.secret.SIGNED_RECORDS_PROVIDER_KEYS
    ).length;
  } catch {
    providerCount = 0;
  }
  if (providerCount === 0) {
    throw new Error('The provider keys in the keys file are malformed');
  }
  if (
    typeof file.public.SIGNED_RECORDS_SERVICE_WALLET !== 'string' ||
    !ADDRESS.test(file.public.SIGNED_RECORDS_SERVICE_WALLET) ||
    !isHex32(file.public.device_key)
  ) {
    throw new Error('A public value in the keys file is malformed');
  }
  serviceKeysOf(file as ServiceKeysFile);
  return file as ServiceKeysFile;
}

/** The same keys with a new device seed; the grant that named the old key goes. */
export function replaceDeviceSeed(
  keys: ServiceKeysFile,
  random: Random = randomBytes
): ServiceKeysFile {
  const seed = hex(random(32));
  const {
    SIGNED_RECORDS_SERVICE_GRANT_ID: _grantId,
    grant_expires_at: _expiresAt,
    ...kept
  } = keys.public;
  return {
    ...keys,
    secret: { ...keys.secret, SIGNED_RECORDS_SERVICE_DEVICE_SEED: seed },
    public: { ...kept, device_key: deviceKeyOfSeed(seed).deviceKey }
  };
}

/** A signing-only grant with the post scope for the device key, 180 days. */
export function buildServiceGrant(args: {
  readonly wallet: string;
  readonly deviceKey: string;
  readonly origin: string;
  readonly nowMs: number;
}): AppDeviceGrant {
  const issuedAt = Math.floor(args.nowMs / 1000);
  return {
    wallet: args.wallet,
    device_key: args.deviceKey,
    scopes: ['post'],
    mls_device_key: null,
    ciphersuite: null,
    version: 2,
    ciphersuites: [],
    issued_at: issuedAt,
    expires_at: Math.floor(issuedAt / 60) * 60 + GRANT_TTL_SECONDS,
    origin: args.origin
  };
}

/** The wallet's EIP-712 signature over the grant, and the grant id. */
export async function signServiceGrant(
  grant: AppDeviceGrant,
  signer: Wallet
): Promise<{ readonly grantId: string; readonly signature: string }> {
  const message = buildAppDeviceGrantMessage(grant);
  const signature = (
    await signer.signTypedData(
      APP_DEVICE_GRANT_DOMAIN_V2,
      APP_DEVICE_GRANT_TYPES_V2,
      message
    )
  ).toLowerCase();
  if (!recoversToAppGrantWallet(message, signature)) {
    throw new Error('The grant signature does not verify');
  }
  return { grantId: computeAppDeviceGrantId(message), signature };
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: 'error';
  }
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** The API calls the setup makes, signed in as the service wallet. */
export class ServiceSetupApi {
  private session: {
    readonly token: string;
    readonly refreshToken: string | null;
    readonly address: string;
  } | null = null;

  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchLike
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T | null> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.session) headers.Authorization = `Bearer ${this.session.token}`;
    const response = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${method} ${path.split('?')[0]} answered ${response.status}: ${text.slice(0, 300)}`
      );
    }
    return text === '' ? null : (JSON.parse(text) as T);
  }

  /** Signs in as an API client (a native session) with the wallet. */
  async signIn(signer: Wallet): Promise<void> {
    const address = signer.address.toLowerCase();
    const nonce = await this.call<{
      signable_message: string;
      server_signature: string;
    }>(
      'GET',
      `/auth/session-nonce?signer_address=${address}&client_type=native`
    );
    if (!nonce) throw new Error('No sign-in challenge');
    const login = await this.call<{
      access_token: string;
      native_refresh_token?: string;
    }>('POST', '/auth/session-login', {
      client_type: 'native',
      server_signature: nonce.server_signature,
      client_signature: await signer.signMessage(nonce.signable_message),
      client_address: address,
      wallet_kind_hint: 'eoa',
      device_label: SERVICE_DEVICE_LABEL
    });
    if (!login?.access_token) throw new Error('Sign-in gave no token');
    this.session = {
      token: login.access_token,
      refreshToken: login.native_refresh_token ?? null,
      address
    };
  }

  /** Ends the session. False when the server did not confirm it. */
  async signOut(): Promise<boolean> {
    const session = this.session;
    if (!session) return true;
    try {
      if (!session.refreshToken) return false;
      await this.call('POST', '/auth/session-logout', {
        client_type: 'native',
        client_address: session.address,
        native_refresh_token: session.refreshToken
      });
      return true;
    } catch {
      return false;
    } finally {
      this.session = null;
    }
  }

  async profileIdOf(wallet: string): Promise<string | null> {
    const identity = await this.call<{ id: string | null }>(
      'GET',
      `/identities/${wallet}`
    );
    return identity?.id ?? null;
  }

  async createProfile(handle: string): Promise<string> {
    const created = await this.call<{ id: string | null }>(
      'POST',
      '/profiles',
      {
        handle,
        classification: 'BOT',
        sub_classification: null,
        pfp_url: null
      }
    );
    if (!created?.id) throw new Error('The profile was not created');
    return created.id;
  }

  async listGrants(): Promise<ServiceGrant[]> {
    return (await this.call<ServiceGrant[]>('GET', '/device-grants')) ?? [];
  }

  async registerGrant(
    grant: AppDeviceGrant,
    signature: string
  ): Promise<string> {
    const stored = await this.call<{ id: string }>('POST', '/device-grants', {
      grant,
      wallet_signature: signature,
      device_label: SERVICE_DEVICE_LABEL
    });
    if (!stored?.id) throw new Error('The grant was not stored');
    return stored.id;
  }

  async revokeGrant(grantId: string): Promise<void> {
    const revoked = await this.call<{ revoked_at: number | null }>(
      'POST',
      `/device-grants/${grantId}/revoke`
    );
    if (!revoked?.revoked_at) throw new Error('The grant was not revoked');
  }
}

export interface SetupDeps {
  readonly fetchFn: FetchLike;
  readonly nowMs: number;
  /** Defaults to SETUP_APIS; tests pass their own. */
  readonly apis?: Readonly<Record<SetupEnvironment, SetupApi>>;
  readonly random?: Random;
  /** Told when the session could not be ended. */
  readonly warn?: (text: string) => void;
}

/** Signs in as the service wallet, runs the steps, and always signs out. */
async function asServiceWallet<T>(
  keys: ServiceKeysFile,
  deps: SetupDeps,
  steps: (api: ServiceSetupApi, origin: string) => Promise<T>
): Promise<T> {
  const { base, origin } = (deps.apis ?? SETUP_APIS)[keys.environment];
  const { signer } = serviceKeysOf(keys);
  const api = new ServiceSetupApi(base, deps.fetchFn);
  await api.signIn(signer);
  try {
    return await steps(api, origin);
  } finally {
    if (!(await api.signOut())) {
      deps.warn?.('The sign-in session could not be ended; it lapses itself.');
    }
  }
}

const isActive = (grant: ServiceGrant, nowMs: number) =>
  grant.revoked_at === null && grant.expires_at > nowMs;

/** Revokes every active grant for a device key; the ids revoked. */
async function revokeAllFor(
  api: ServiceSetupApi,
  deviceKey: string,
  nowMs: number
): Promise<string[]> {
  const active = (await api.listGrants()).filter(
    (grant) => grant.device_key === deviceKey && isActive(grant, nowMs)
  );
  for (const grant of active) await api.revokeGrant(grant.id);
  return active.map((grant) => grant.id);
}

const appended = (
  list: readonly string[] | undefined,
  ids: readonly string[]
): string[] => {
  const all = [...(list ?? [])];
  for (const id of ids) if (all.indexOf(id) < 0) all.push(id);
  return all;
};

/**
 * Signs in as the service wallet, makes its profile when it has none (with
 * the handle given), and registers a new 180-day grant for the device key.
 * Run again to renew: the keys stay and the grant id changes. With
 * newDeviceSeed, every active grant for the old device key is revoked first
 * and the seed is replaced. A device key with a revoked grant is not granted
 * again: it may have leaked.
 */
export async function grantServiceDevice(
  args: {
    readonly keys: ServiceKeysFile;
    readonly handle: string | null;
    readonly newDeviceSeed: boolean;
  },
  deps: SetupDeps
): Promise<ServiceKeysFile> {
  const { base } = (deps.apis ?? SETUP_APIS)[args.keys.environment];
  return asServiceWallet(args.keys, deps, async (api, origin) => {
    const { wallet } = serviceKeysOf(args.keys);
    let profileId = await api.profileIdOf(wallet);
    if (!profileId) {
      if (!args.handle) {
        throw new Error('The service wallet has no profile yet: pass --handle');
      }
      profileId = await api.createProfile(args.handle);
    }
    let keys = args.keys;
    let revoked: string[] = [];
    if (args.newDeviceSeed) {
      revoked = await revokeAllFor(api, keys.public.device_key, deps.nowMs);
      keys = replaceDeviceSeed(keys, deps.random);
    } else if (
      (await api.listGrants()).some(
        (grant) =>
          grant.device_key === keys.public.device_key &&
          grant.revoked_at !== null
      )
    ) {
      throw new Error(
        'A grant for this device key was revoked: run grant with --new-device-seed'
      );
    }
    const { signer, deviceKey } = serviceKeysOf(keys);
    const grant = buildServiceGrant({
      wallet,
      deviceKey,
      origin,
      nowMs: deps.nowMs
    });
    const { grantId, signature } = await signServiceGrant(grant, signer);
    const storedId = await api.registerGrant(grant, signature);
    if (storedId !== grantId) {
      throw new Error('The server stored a different grant id');
    }
    const earlier = args.keys.public.SIGNED_RECORDS_SERVICE_GRANT_ID;
    return {
      ...keys,
      public: {
        ...keys.public,
        api: base,
        SIGNED_RECORDS_SERVICE_PROFILE_ID: profileId,
        SIGNED_RECORDS_SERVICE_GRANT_ID: grantId,
        grant_expires_at: new Date(grant.expires_at * 1000).toISOString(),
        previous_grant_ids: appended(
          keys.public.previous_grant_ids,
          earlier && earlier !== grantId ? [earlier] : []
        ),
        revoked_grant_ids: appended(keys.public.revoked_grant_ids, revoked)
      }
    };
  });
}

/**
 * Revokes one grant of the service wallet, or every active grant for the
 * file's device key, so that key can no longer sign. The service stops
 * posting until a new grant is in its config.
 */
export async function revokeServiceGrants(
  args: {
    readonly keys: ServiceKeysFile;
    readonly grantId: string | null;
    readonly allForDevice: boolean;
  },
  deps: SetupDeps
): Promise<{ readonly keys: ServiceKeysFile; readonly revoked: string[] }> {
  if ((args.grantId === null) === !args.allForDevice) {
    throw new Error('Pass either --grant or --all-for-device');
  }
  const revoked = await asServiceWallet(args.keys, deps, async (api) => {
    if (args.grantId !== null) {
      await api.revokeGrant(args.grantId);
      return [args.grantId];
    }
    return revokeAllFor(api, args.keys.public.device_key, deps.nowMs);
  });
  return {
    keys: {
      ...args.keys,
      public: {
        ...args.keys.public,
        revoked_grant_ids: appended(args.keys.public.revoked_grant_ids, revoked)
      }
    },
    revoked
  };
}

/** The service wallet's grants, as the server lists them. */
export async function listServiceGrants(
  keys: ServiceKeysFile,
  deps: SetupDeps
): Promise<ServiceGrant[]> {
  return asServiceWallet(keys, deps, (api) => api.listGrants());
}
