import { createHash } from 'node:crypto';
import { AppDeviceGrant } from '@/api/device-signing/app-device-grant';
import { evaluateGrantOrigin } from '@/api/device-signing/grant-origins';
import { getWebAppSignatureDomainsForApiHost } from '@/api/web-app-origins';
import { loadProviderKeys } from '../sealed-crypto';
import { loadServiceIdentity } from './records-wave-poster';
import { fakeSetupApi } from './service-setup-test-api';
import {
  createServiceKeys,
  grantServiceDevice,
  listServiceGrants,
  parseKeysFile,
  replaceDeviceSeed,
  revokeServiceGrants,
  ServiceGrant,
  ServiceKeysFile,
  SETUP_APIS,
  SETUP_ENVIRONMENTS
} from './service-setup';

const NOW = Date.UTC(2026, 10, 23, 8, 30, 15);
const DAY = 24 * 60 * 60;
const STAGING = SETUP_APIS.staging.base;
const ORIGIN_ENVS = [
  'WEB_APP_ORIGIN',
  'WEB_APP_ADDITIONAL_ORIGINS',
  'AUTH_WEB_CREDENTIAL_ORIGINS'
];

/** Deterministic bytes, so the keys are the same on every run. */
function fixedRandom(label = 'setup-test') {
  let counter = 0;
  return (size: number) =>
    createHash('sha256')
      .update(`${label}-${counter++}`)
      .digest()
      .subarray(0, size);
}

const newKeys = (environment: 'staging' | 'production' = 'staging') =>
  createServiceKeys(environment, new Date(NOW), fixedRandom());

const api = (options: Partial<Parameters<typeof fakeSetupApi>[0]> = {}) =>
  fakeSetupApi({ base: STAGING, nowMs: NOW, ...options });

const deps = (fake: ReturnType<typeof api>, warn?: (text: string) => void) => ({
  fetchFn: fake.fetchFn,
  nowMs: NOW,
  random: fixedRandom('replacement'),
  ...(warn ? { warn } : {})
});

const grant = (
  keys: ServiceKeysFile,
  fake: ReturnType<typeof api>,
  options: { handle?: string | null; newDeviceSeed?: boolean } = {}
) =>
  grantServiceDevice(
    {
      keys,
      handle: options.handle === undefined ? 'records_test' : options.handle,
      newDeviceSeed: options.newDeviceSeed ?? false
    },
    deps(fake)
  );

const grantOf = (
  id: string,
  deviceKey: string,
  state: Partial<ServiceGrant> = {}
): ServiceGrant => ({
  id,
  device_key: deviceKey,
  device_label: null,
  created_at: NOW - DAY * 1000,
  expires_at: NOW + 30 * DAY * 1000,
  revoked_at: null,
  ...state
});

const id = (byte: string) => `0x${byte.repeat(32)}`;

describe('records service setup', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of ORIGIN_ENVS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of ORIGIN_ENVS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  describe('keys', () => {
    it('makes keys the service reads back as written', () => {
      const keys = newKeys();
      const identity = loadServiceIdentity({
        SIGNED_RECORDS_WAVE_ID: 'wave-id',
        SIGNED_RECORDS_SERVICE_PROFILE_ID: 'profile-id',
        SIGNED_RECORDS_SERVICE_WALLET:
          keys.public.SIGNED_RECORDS_SERVICE_WALLET,
        SIGNED_RECORDS_SERVICE_GRANT_ID: id('ab'),
        SIGNED_RECORDS_SERVICE_DEVICE_SEED:
          keys.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED
      });
      expect(identity?.deviceKey).toBe(keys.public.device_key);
      const providers = loadProviderKeys(
        keys.secret.SIGNED_RECORDS_PROVIDER_KEYS
      );
      expect(keys.public.provider_public_keys).toEqual([
        {
          id: 'staging-20261123083015',
          public_key: `0x${providers[0].publicKey.toString('hex')}`
        }
      ]);
      expect(parseKeysFile(JSON.stringify(keys))).toEqual(keys);
    });

    it('makes new keys and a new provider key id each time', () => {
      const first = createServiceKeys('production');
      const second = createServiceKeys('production');
      expect(first.secret).not.toEqual(second.secret);
      const later = createServiceKeys(
        'production',
        new Date(NOW + 1000),
        fixedRandom()
      );
      expect(later.public.provider_public_keys[0].id).not.toBe(
        newKeys('production').public.provider_public_keys[0].id
      );
    });

    it('refuses a damaged keys file without quoting it', () => {
      const keys = newKeys();
      const walletKey = keys.secret.service_wallet_private_key;
      const damaged = (change: (file: any) => void) => {
        const file = JSON.parse(JSON.stringify(keys));
        change(file);
        return JSON.stringify(file);
      };
      const cases: [string, string][] = [
        [`${JSON.stringify(keys).slice(0, -1)}`, 'not valid JSON'],
        [
          damaged((file) => {
            file.secret.service_wallet_private_key = ` ${walletKey}`;
          }),
          'A secret in the keys file is malformed'
        ],
        [
          damaged((file) => {
            file.secret.service_wallet_private_key = id('00');
          }),
          'service wallet key in the keys file is not usable'
        ],
        [
          damaged((file) => {
            file.secret.SIGNED_RECORDS_PROVIDER_KEYS = `[{"id":"x","private_key":"${walletKey} "}]`;
          }),
          'provider keys in the keys file are malformed'
        ],
        [
          damaged((file) => {
            file.environment = 'dev';
          }),
          'names no known environment'
        ],
        [
          damaged((file) => {
            file.public.device_key = id('00');
          }),
          'does not match its own public values'
        ],
        ['[]', 'not a records service keys file']
      ];
      for (const [text, message] of cases) {
        let thrown: Error | null = null;
        try {
          parseKeysFile(text);
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown?.message).toContain(message);
        expect(thrown?.message).not.toContain(walletKey.slice(2, 20));
      }
    });
  });

  describe('APIs', () => {
    it.each(SETUP_ENVIRONMENTS)(
      'pairs the %s API with the origin the server recognises',
      (environment) => {
        const { base, origin } = SETUP_APIS[environment];
        const url = new URL(base);
        expect(url.protocol).toBe('https:');
        expect(url.pathname).toBe('/api');
        expect(getWebAppSignatureDomainsForApiHost(url.host)).toEqual([origin]);
        expect(evaluateGrantOrigin(origin, url.host)).toEqual({
          recognized: true,
          reason: 'web_origin'
        });
      }
    );

    it('keeps the origin fixed when the shell adds web origins', async () => {
      process.env.WEB_APP_ORIGIN = 'https://web.example.test';
      const fake = api();
      await grant(newKeys(), fake);
      const sent = fake.calls.find(
        (call) => call.method === 'POST' && call.path === '/device-grants'
      );
      expect(sent?.body.grant.origin).toBe('staging.6529.io');
    });

    it("uses the API of the file's environment", async () => {
      const fake = fakeSetupApi({
        base: SETUP_APIS.production.base,
        nowMs: NOW
      });
      const granted = await grant(newKeys('production'), fake);
      expect(granted.public.api).toBe(SETUP_APIS.production.base);
      await expect(grant(newKeys('staging'), fake)).rejects.toThrow(
        'answered 500'
      );
    });
  });

  describe('grant', () => {
    it('signs in, makes the profile, registers a post-only grant and signs out', async () => {
      const keys = newKeys();
      const fake = api();
      const granted = await grant(keys, fake);
      const wallet = keys.public.SIGNED_RECORDS_SERVICE_WALLET;
      expect(fake.routes()).toEqual([
        `GET /auth/session-nonce?signer_address=${wallet}&client_type=native`,
        'POST /auth/session-login',
        `GET /identities/${wallet}`,
        'POST /profiles',
        'GET /device-grants',
        'POST /device-grants',
        'POST /auth/session-logout'
      ]);
      expect(fake.signedIn()).toBe(false);
      expect(fake.calls[3].body).toEqual({
        handle: 'records_test',
        classification: 'BOT',
        sub_classification: null,
        pfp_url: null
      });
      const sent = fake.calls[5].body.grant as AppDeviceGrant;
      expect(sent).toMatchObject({
        wallet,
        device_key: keys.public.device_key,
        scopes: ['post'],
        mls_device_key: null,
        ciphersuites: [],
        origin: 'staging.6529.io',
        issued_at: Math.floor(NOW / 1000)
      });
      expect(sent.expires_at).toBe(
        Math.floor(Math.floor(NOW / 1000) / 60) * 60 + 180 * DAY
      );
      expect(granted.public).toMatchObject({
        api: STAGING,
        SIGNED_RECORDS_SERVICE_PROFILE_ID: 'new-profile-id',
        SIGNED_RECORDS_SERVICE_GRANT_ID: fake.grants[0].id,
        grant_expires_at: new Date(sent.expires_at * 1000).toISOString(),
        previous_grant_ids: [],
        revoked_grant_ids: []
      });
      expect(granted.secret).toEqual(keys.secret);
    });

    it('keeps an existing profile, and a renewal keeps the keys', async () => {
      const fake = api({ profileId: 'existing-profile-id' });
      const first = await grant(newKeys(), fake, { handle: null });
      expect(fake.routes()).not.toContain('POST /profiles');
      const renewed = await grantServiceDevice(
        { keys: first, handle: null, newDeviceSeed: false },
        { ...deps(fake), nowMs: NOW + 60_000 }
      );
      expect(renewed.secret).toEqual(first.secret);
      expect(renewed.public.SIGNED_RECORDS_SERVICE_GRANT_ID).not.toBe(
        first.public.SIGNED_RECORDS_SERVICE_GRANT_ID
      );
      expect(renewed.public.previous_grant_ids).toEqual([
        first.public.SIGNED_RECORDS_SERVICE_GRANT_ID
      ]);
    });

    it('refuses to grant a device key that had a grant revoked', async () => {
      const keys = newKeys();
      const fake = api({
        profileId: 'p',
        grants: [
          grantOf(id('01'), keys.public.device_key, { revoked_at: NOW - 1 })
        ]
      });
      await expect(grant(keys, fake)).rejects.toThrow('--new-device-seed');
      expect(fake.routes()).not.toContain('POST /device-grants');
      expect(fake.signedIn()).toBe(false);
    });

    it('with a new device seed, revokes every active grant for the old key first', async () => {
      const keys = newKeys();
      const old = keys.public.device_key;
      const other = id('77');
      const fake = api({
        profileId: 'p',
        grants: [
          grantOf(id('01'), old),
          grantOf(id('02'), old),
          grantOf(id('03'), old, { revoked_at: NOW - 5 }),
          grantOf(id('04'), old, { expires_at: NOW - 5 }),
          grantOf(id('05'), other)
        ]
      });
      const replaced = await grant(
        {
          ...keys,
          public: { ...keys.public, SIGNED_RECORDS_SERVICE_GRANT_ID: id('02') }
        },
        fake,
        { newDeviceSeed: true }
      );
      const revokes = fake
        .routes()
        .filter((route) => route.endsWith('/revoke'));
      expect(revokes).toEqual([
        `POST /device-grants/${id('01')}/revoke`,
        `POST /device-grants/${id('02')}/revoke`
      ]);
      expect(fake.routes().indexOf(revokes[1])).toBeLessThan(
        fake.routes().indexOf('POST /device-grants')
      );
      expect(replaced.public.revoked_grant_ids).toEqual([id('01'), id('02')]);
      expect(replaced.public.previous_grant_ids).toEqual([id('02')]);
      expect(replaced.public.device_key).not.toBe(old);
      expect(replaced.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED).not.toBe(
        keys.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED
      );
      expect(replaced.secret.service_wallet_private_key).toBe(
        keys.secret.service_wallet_private_key
      );
      expect(replaced.secret.SIGNED_RECORDS_PROVIDER_KEYS).toBe(
        keys.secret.SIGNED_RECORDS_PROVIDER_KEYS
      );
      const added = fake.grants[fake.grants.length - 1];
      expect(added.device_key).toBe(replaced.public.device_key);
      expect(replaced.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toBe(added.id);
      expect(fake.grants.find((g) => g.id === id('05'))?.revoked_at).toBeNull();
    });

    it('replaceDeviceSeed drops the grant that named the old key', () => {
      const keys = {
        ...newKeys(),
        public: {
          ...newKeys().public,
          SIGNED_RECORDS_SERVICE_GRANT_ID: id('02'),
          grant_expires_at: 'x'
        }
      };
      const replaced = replaceDeviceSeed(keys, fixedRandom('other'));
      expect(replaced.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toBeUndefined();
      expect(replaced.public.grant_expires_at).toBeUndefined();
      expect(replaced.public.device_key).not.toBe(keys.public.device_key);
    });

    it('refuses a wallet without a profile when no handle is given, and signs out', async () => {
      const fake = api();
      await expect(grant(newKeys(), fake, { handle: null })).rejects.toThrow(
        'pass --handle'
      );
      expect(fake.routes()).toContain('POST /auth/session-logout');
    });

    it('fails when the server stores another grant id', async () => {
      const fake = api({ storedId: id('cd') });
      await expect(grant(newKeys(), fake)).rejects.toThrow(
        'different grant id'
      );
    });

    it('reports a refused call with its status', async () => {
      const fake = api();
      const refusing: typeof fake.fetchFn = async (url, init) =>
        url.endsWith('/auth/session-login')
          ? { status: 401, text: async () => '{"error":"refused"}' }
          : fake.fetchFn(url, init);
      await expect(
        grantServiceDevice(
          { keys: newKeys(), handle: 'records_test', newDeviceSeed: false },
          { fetchFn: refusing, nowMs: NOW }
        )
      ).rejects.toThrow('POST /auth/session-login answered 401');
    });

    it('warns when the session could not be ended', async () => {
      const warnings: string[] = [];
      const fake = api({ failLogout: true });
      await grantServiceDevice(
        { keys: newKeys(), handle: 'records_test', newDeviceSeed: false },
        deps(fake, (text) => warnings.push(text))
      );
      expect(warnings).toEqual([
        'The sign-in session could not be ended; it lapses itself.'
      ]);
    });
  });

  describe('revoke and list', () => {
    it('revokes one grant by id', async () => {
      const keys = newKeys();
      const fake = api({ grants: [grantOf(id('01'), keys.public.device_key)] });
      const result = await revokeServiceGrants(
        { keys, grantId: id('01'), allForDevice: false },
        deps(fake)
      );
      expect(result.revoked).toEqual([id('01')]);
      expect(result.keys.public.revoked_grant_ids).toEqual([id('01')]);
      expect(fake.grants[0].revoked_at).toBe(NOW);
      expect(fake.signedIn()).toBe(false);
    });

    it("revokes every active grant for the file's device key", async () => {
      const keys = newKeys();
      const key = keys.public.device_key;
      const fake = api({
        grants: [
          grantOf(id('01'), key),
          grantOf(id('02'), key),
          grantOf(id('03'), key, { revoked_at: NOW - 5 }),
          grantOf(id('05'), id('77'))
        ]
      });
      const result = await revokeServiceGrants(
        { keys, grantId: null, allForDevice: true },
        deps(fake)
      );
      expect(result.revoked).toEqual([id('01'), id('02')]);
      expect(fake.grants.map((g) => g.revoked_at !== null)).toEqual([
        true,
        true,
        true,
        false
      ]);
    });

    it('needs exactly one of a grant id or all for the device', async () => {
      const keys = newKeys();
      for (const choice of [
        { grantId: null, allForDevice: false },
        { grantId: id('01'), allForDevice: true }
      ]) {
        await expect(
          revokeServiceGrants({ keys, ...choice }, deps(api()))
        ).rejects.toThrow('either --grant or --all-for-device');
      }
    });

    it("lists the wallet's grants", async () => {
      const keys = newKeys();
      const listed = [grantOf(id('01'), keys.public.device_key)];
      await expect(
        listServiceGrants(keys, deps(api({ grants: listed })))
      ).resolves.toEqual(listed);
    });
  });
});
