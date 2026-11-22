import { createHash } from 'node:crypto';
import { verifyMessage } from 'ethers';
import {
  AppDeviceGrant,
  findAppDeviceGrantRegistrationProblem,
  verifyAppDeviceGrant
} from '@/api/device-signing/app-device-grant';
import { registerDeviceGrantSchema } from '@/api/device-signing/device-signing.validation';
import { loadProviderKeys } from '../sealed-crypto';
import { loadServiceIdentity } from './records-wave-poster';
import {
  createServiceKeys,
  grantServiceDevice,
  replaceDeviceSeed,
  resolveSetupApi,
  revokeServiceGrant,
  ServiceKeysFile
} from './service-setup';

const API = 'https://api.example.test';
const NOW = Date.UTC(2026, 10, 23, 8, 30, 15);
const DAY = 24 * 60 * 60;

/** Deterministic bytes, so the keys are the same on every run. */
function fixedRandom() {
  let counter = 0;
  return (size: number) =>
    createHash('sha256')
      .update(`setup-test-${counter++}`)
      .digest()
      .subarray(0, size);
}

const newKeys = () =>
  createServiceKeys('staging', new Date(NOW), fixedRandom());

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: any;
}

/** A stand-in for the API that checks what the setup sends. */
function fakeApi(options: { profileId?: string; storedId?: string } = {}) {
  const calls: Call[] = [];
  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => JSON.stringify(body)
  });
  const fetchFn = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    const path = url.slice(`${API}/api`.length);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path, headers: init.headers, body });
    if (path.startsWith('/auth/session-nonce?')) {
      return reply(200, {
        signable_message: 'Sign in to the test API',
        server_signature: 'server-signature'
      });
    }
    if (path === '/auth/session-login') {
      const signer = verifyMessage(
        'Sign in to the test API',
        body.client_signature
      ).toLowerCase();
      return signer === body.client_address
        ? reply(201, { access_token: 'access-token' })
        : reply(401, { error: 'bad signature' });
    }
    if (path.startsWith('/identities/')) {
      return options.profileId
        ? reply(200, { id: options.profileId })
        : reply(404, { error: 'not found' });
    }
    if (path === '/profiles') {
      return reply(201, { id: 'new-profile-id' });
    }
    if (path === '/device-grants') {
      const checked = registerDeviceGrantSchema.validate(body);
      if (checked.error) return reply(400, { error: checked.error.message });
      const grant = body.grant as AppDeviceGrant;
      const problem = findAppDeviceGrantRegistrationProblem(
        grant,
        Math.floor(NOW / 1000)
      );
      const verification = await verifyAppDeviceGrant({
        grant,
        signature: body.wallet_signature,
        contractWalletVerifier: {
          hasCode: async () => false,
          isValidSignature: async () => false
        }
      });
      if (problem || !verification.ok) {
        return reply(400, { error: problem ?? 'signature' });
      }
      return reply(201, { id: options.storedId ?? verification.grantId });
    }
    const revoke = /^\/device-grants\/(0x[0-9a-f]{64})\/revoke$/.exec(path);
    if (revoke) {
      return reply(200, { id: revoke[1], revoked_at: NOW });
    }
    return reply(500, { error: `unexpected ${path}` });
  };
  return { calls, fetchFn };
}

const grant = (
  keys: ServiceKeysFile,
  fetchFn: ReturnType<typeof fakeApi>['fetchFn'],
  handle: string | null = 'records_test'
) => grantServiceDevice({ keys, api: API, handle, fetchFn, nowMs: NOW });

describe('records service setup', () => {
  beforeEach(() => {
    process.env.WEB_APP_ORIGIN = 'https://web.example.test';
  });
  afterEach(() => {
    delete process.env.WEB_APP_ORIGIN;
  });

  it('makes keys the service reads back as written', () => {
    const keys = newKeys();
    const identity = loadServiceIdentity({
      SIGNED_RECORDS_WAVE_ID: 'wave-id',
      SIGNED_RECORDS_SERVICE_PROFILE_ID: 'profile-id',
      SIGNED_RECORDS_SERVICE_WALLET: keys.public.SIGNED_RECORDS_SERVICE_WALLET,
      SIGNED_RECORDS_SERVICE_GRANT_ID: `0x${'ab'.repeat(32)}`,
      SIGNED_RECORDS_SERVICE_DEVICE_SEED:
        keys.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED
    });
    expect(identity?.deviceKey).toBe(keys.public.device_key);
    const providers = loadProviderKeys(
      keys.secret.SIGNED_RECORDS_PROVIDER_KEYS
    );
    expect(providers.map((provider) => provider.id)).toEqual([
      'staging-20261123'
    ]);
    expect(keys.public.provider_public_keys).toEqual([
      {
        id: 'staging-20261123',
        public_key: `0x${providers[0].publicKey.toString('hex')}`
      }
    ]);
    expect(keys.public.SIGNED_RECORDS_SERVICE_WALLET).toMatch(
      /^0x[0-9a-f]{40}$/
    );
  });

  it('makes different keys each time by default', () => {
    const first = createServiceKeys('production');
    const second = createServiceKeys('production');
    expect(first.secret).not.toEqual(second.secret);
  });

  it('accepts only an API whose web origin is known', () => {
    expect(resolveSetupApi(`${API}/`)).toEqual({
      base: `${API}/api`,
      origin: 'web.example.test'
    });
    delete process.env.WEB_APP_ORIGIN;
    expect(() => resolveSetupApi(API)).toThrow('staging or production API');
    expect(() => resolveSetupApi('not a url')).toThrow('must be a URL');
  });

  it('signs in, makes the profile and registers a post-only grant', async () => {
    const keys = newKeys();
    const api = fakeApi();
    const granted = await grant(keys, api.fetchFn);
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /auth/session-nonce?signer_address=${keys.public.SIGNED_RECORDS_SERVICE_WALLET}&client_type=native`,
      'POST /auth/session-login',
      `GET /identities/${keys.public.SIGNED_RECORDS_SERVICE_WALLET}`,
      'POST /profiles',
      'POST /device-grants'
    ]);
    expect(api.calls[3].headers.Authorization).toBe('Bearer access-token');
    expect(api.calls[3].body).toEqual({
      handle: 'records_test',
      classification: 'BOT',
      sub_classification: null,
      pfp_url: null
    });
    const sent = api.calls[4].body.grant as AppDeviceGrant;
    expect(sent).toMatchObject({
      wallet: keys.public.SIGNED_RECORDS_SERVICE_WALLET,
      device_key: keys.public.device_key,
      scopes: ['post'],
      mls_device_key: null,
      ciphersuites: [],
      origin: 'web.example.test',
      issued_at: Math.floor(NOW / 1000)
    });
    expect(sent.expires_at % 60).toBe(0);
    expect(sent.expires_at - sent.issued_at).toBeLessThanOrEqual(180 * DAY);
    expect(granted.public).toMatchObject({
      api: `${API}/api`,
      SIGNED_RECORDS_SERVICE_PROFILE_ID: 'new-profile-id',
      grant_expires_at: new Date(sent.expires_at * 1000).toISOString()
    });
    expect(granted.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toMatch(
      /^0x[0-9a-f]{64}$/
    );
    expect(granted.secret).toEqual(keys.secret);
  });

  it('keeps an existing profile and renews with the same keys', async () => {
    const keys = newKeys();
    const api = fakeApi({ profileId: 'existing-profile-id' });
    const first = await grant(keys, api.fetchFn, null);
    expect(api.calls.some((call) => call.path === '/profiles')).toBe(false);
    expect(first.public.SIGNED_RECORDS_SERVICE_PROFILE_ID).toBe(
      'existing-profile-id'
    );
    const renewed = await grantServiceDevice({
      keys: first,
      api: API,
      handle: null,
      fetchFn: fakeApi({ profileId: 'existing-profile-id' }).fetchFn,
      nowMs: NOW
    });
    expect(renewed.secret).toEqual(keys.secret);
  });

  it('refuses a wallet without a profile when no handle is given', async () => {
    await expect(grant(newKeys(), fakeApi().fetchFn, null)).rejects.toThrow(
      'pass --handle'
    );
  });

  it('refuses keys granted on another API', async () => {
    const keys = newKeys();
    const moved: ServiceKeysFile = {
      ...keys,
      public: { ...keys.public, api: 'https://other.example.test/api' }
    };
    await expect(grant(moved, fakeApi().fetchFn)).rejects.toThrow(
      'another API'
    );
  });

  it('refuses a keys file whose public values do not match', async () => {
    const keys = newKeys();
    const edited: ServiceKeysFile = {
      ...keys,
      public: { ...keys.public, device_key: `0x${'00'.repeat(32)}` }
    };
    await expect(grant(edited, fakeApi().fetchFn)).rejects.toThrow(
      'does not match'
    );
  });

  it('fails when the server stores another grant id', async () => {
    const api = fakeApi({ storedId: `0x${'cd'.repeat(32)}` });
    await expect(grant(newKeys(), api.fetchFn)).rejects.toThrow(
      'different grant id'
    );
  });

  it('reports a refused call with its status', async () => {
    const keys = newKeys();
    const api = fakeApi();
    const failing = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string }
    ) =>
      url.endsWith('/auth/session-login')
        ? { status: 401, text: async () => '{"error":"refused"}' }
        : api.fetchFn(url, init);
    await expect(grant(keys, failing)).rejects.toThrow(
      'POST /auth/session-login answered 401'
    );
  });

  it('replaces a device seed and drops the grant that named the old key', async () => {
    const granted = await grant(newKeys(), fakeApi().fetchFn);
    const replaced = replaceDeviceSeed(granted, () =>
      createHash('sha256').update('replacement seed').digest()
    );
    expect(replaced.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED).not.toBe(
      granted.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED
    );
    expect(replaced.secret.service_wallet_private_key).toBe(
      granted.secret.service_wallet_private_key
    );
    expect(replaced.secret.SIGNED_RECORDS_PROVIDER_KEYS).toBe(
      granted.secret.SIGNED_RECORDS_PROVIDER_KEYS
    );
    expect(replaced.public.device_key).not.toBe(granted.public.device_key);
    expect(replaced.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toBeUndefined();
    expect(replaced.public.grant_expires_at).toBeUndefined();
    expect(replaced.public.SIGNED_RECORDS_SERVICE_PROFILE_ID).toBe(
      granted.public.SIGNED_RECORDS_SERVICE_PROFILE_ID
    );
    const api = fakeApi({ profileId: 'existing-profile-id' });
    const regranted = await grant(replaced, api.fetchFn, null);
    expect(api.calls[3].body.grant.device_key).toBe(replaced.public.device_key);
    expect(regranted.public.SIGNED_RECORDS_SERVICE_GRANT_ID).not.toBe(
      granted.public.SIGNED_RECORDS_SERVICE_GRANT_ID
    );
  });

  it('revokes the current grant, or the one named', async () => {
    const granted = await grant(newKeys(), fakeApi().fetchFn);
    const api = fakeApi();
    const current = await revokeServiceGrant({
      keys: granted,
      api: API,
      grantId: null,
      fetchFn: api.fetchFn
    });
    expect(current).toBe(granted.public.SIGNED_RECORDS_SERVICE_GRANT_ID);
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /auth/session-nonce?signer_address=${granted.public.SIGNED_RECORDS_SERVICE_WALLET}&client_type=native`,
      'POST /auth/session-login',
      `POST /device-grants/${current}/revoke`
    ]);
    expect(api.calls[2].headers.Authorization).toBe('Bearer access-token');
    const named = `0x${'ef'.repeat(32)}`;
    await expect(
      revokeServiceGrant({
        keys: granted,
        api: API,
        grantId: named,
        fetchFn: fakeApi().fetchFn
      })
    ).resolves.toBe(named);
    await expect(
      revokeServiceGrant({
        keys: newKeys(),
        api: API,
        grantId: null,
        fetchFn: fakeApi().fetchFn
      })
    ).rejects.toThrow('pass --grant');
  });
});
