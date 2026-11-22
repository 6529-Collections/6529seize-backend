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
import { getWebAppSignatureDomainsForApiHost } from '@/api/web-app-origins';
import { loadProviderKeys } from '../sealed-crypto';
import { deviceKeyOfSeed } from './records-wave-poster';

/**
 * Setup of the records service identity, run by whoever holds its keys on
 * their own machine (service-setup.cli.ts): new keys into a local file, then
 * a device grant for the device key, signed by the service wallet. Secrets
 * stay in the file; only public values are printed.
 */

export const SETUP_ENVIRONMENTS = ['staging', 'production'] as const;
export type SetupEnvironment = (typeof SETUP_ENVIRONMENTS)[number];

export const SERVICE_DEVICE_LABEL = 'Signed records service';

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
}

const hex = (bytes: Buffer) => `0x${bytes.toString('hex')}`;

/** A new service wallet, device seed and provider key for one environment. */
export function createServiceKeys(
  environment: SetupEnvironment,
  now: Date = new Date(),
  random: (size: number) => Buffer = randomBytes
): ServiceKeysFile {
  const wallet = new Wallet(hex(random(32)));
  const seed = hex(random(32));
  const providerId = `${environment}-${now
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')}`;
  const providerKeys = JSON.stringify([
    { id: providerId, private_key: hex(random(32)) }
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

/**
 * The API base and the web origin a grant names for it. Only an API whose
 * web origin the server knows is accepted, so a typo fails here.
 */
export function resolveSetupApi(api: string): {
  readonly base: string;
  readonly origin: string;
} {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error('--api must be a URL');
  }
  const origin = getWebAppSignatureDomainsForApiHost(url.host)[0];
  if (url.protocol !== 'https:' || !origin) {
    throw new Error(
      '--api must be the https address of the staging or production API'
    );
  }
  return { base: `${url.origin}/api`, origin };
}

/** A signing-only grant with the post scope for the device key. */
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

type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
  }
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** The few API calls the setup makes, signed in as the service wallet. */
export class ServiceSetupApi {
  private token: string | null = null;

  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchLike
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ readonly status: number; readonly body: T | null }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    if (response.status === 404) return { status: 404, body: null };
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`
      );
    }
    return { status: response.status, body: JSON.parse(text) as T };
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
    if (!nonce.body) throw new Error('No sign-in challenge');
    const login = await this.call<{ access_token: string }>(
      'POST',
      '/auth/session-login',
      {
        client_type: 'native',
        server_signature: nonce.body.server_signature,
        client_signature: await signer.signMessage(nonce.body.signable_message),
        client_address: address,
        wallet_kind_hint: 'eoa',
        device_label: SERVICE_DEVICE_LABEL
      }
    );
    if (!login.body?.access_token) throw new Error('Sign-in gave no token');
    this.token = login.body.access_token;
  }

  async profileIdOf(wallet: string): Promise<string | null> {
    const identity = await this.call<{ id: string | null }>(
      'GET',
      `/identities/${wallet}`
    );
    return identity.body?.id ?? null;
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
    if (!created.body?.id) throw new Error('The profile was not created');
    return created.body.id;
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
    if (!stored.body?.id) throw new Error('The grant was not stored');
    return stored.body.id;
  }

  async revokeGrant(grantId: string): Promise<void> {
    const revoked = await this.call<{ revoked_at: number | null }>(
      'POST',
      `/device-grants/${grantId}/revoke`
    );
    if (!revoked.body?.revoked_at) throw new Error('The grant was not revoked');
  }
}

/** The API base, refusing keys already granted on another API. */
function setupApiFor(keys: ServiceKeysFile, api: string) {
  const resolved = resolveSetupApi(api);
  if (keys.public.api && keys.public.api !== resolved.base) {
    throw new Error(
      `These keys were granted on another API (${keys.public.api})`
    );
  }
  return resolved;
}

/** The service wallet and device key, checked against the file's public values. */
function serviceKeysOf(keys: ServiceKeysFile) {
  const signer = new Wallet(keys.secret.service_wallet_private_key);
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
 * The same keys with a new device seed, for when the seed may have leaked.
 * The old grant id goes too: it names the old device key.
 */
export function replaceDeviceSeed(
  keys: ServiceKeysFile,
  random: (size: number) => Buffer = randomBytes
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

/**
 * Signs in as the service wallet, makes its profile when it has none (with
 * the handle given), and registers a new 180-day grant for the device key.
 * Run again to renew: the keys stay, the grant id changes.
 */
export async function grantServiceDevice(args: {
  readonly keys: ServiceKeysFile;
  readonly api: string;
  readonly handle: string | null;
  readonly fetchFn: FetchLike;
  readonly nowMs: number;
}): Promise<ServiceKeysFile> {
  const { keys } = args;
  const { base, origin } = setupApiFor(keys, args.api);
  const { signer, wallet, deviceKey } = serviceKeysOf(keys);
  const api = new ServiceSetupApi(base, args.fetchFn);
  await api.signIn(signer);
  let profileId = await api.profileIdOf(wallet);
  if (!profileId) {
    if (!args.handle) {
      throw new Error('The service wallet has no profile yet: pass --handle');
    }
    profileId = await api.createProfile(args.handle);
  }
  const grant = buildServiceGrant({
    wallet,
    deviceKey,
    origin,
    nowMs: args.nowMs
  });
  const { grantId, signature } = await signServiceGrant(grant, signer);
  const storedId = await api.registerGrant(grant, signature);
  if (storedId !== grantId) {
    throw new Error('The server stored a different grant id');
  }
  return {
    ...keys,
    public: {
      ...keys.public,
      api: base,
      SIGNED_RECORDS_SERVICE_PROFILE_ID: profileId,
      SIGNED_RECORDS_SERVICE_GRANT_ID: grantId,
      grant_expires_at: new Date(grant.expires_at * 1000).toISOString()
    }
  };
}

/**
 * Revokes a grant of the service wallet (by default the file's current one),
 * so its device key can no longer sign. The service stops posting until a
 * new grant is in its config.
 */
export async function revokeServiceGrant(args: {
  readonly keys: ServiceKeysFile;
  readonly api: string;
  readonly grantId: string | null;
  readonly fetchFn: FetchLike;
}): Promise<string> {
  const { base } = setupApiFor(args.keys, args.api);
  const grantId =
    args.grantId ?? args.keys.public.SIGNED_RECORDS_SERVICE_GRANT_ID;
  if (!grantId) throw new Error('No grant to revoke: pass --grant');
  const { signer } = serviceKeysOf(args.keys);
  const api = new ServiceSetupApi(base, args.fetchFn);
  await api.signIn(signer);
  await api.revokeGrant(grantId);
  return grantId;
}
