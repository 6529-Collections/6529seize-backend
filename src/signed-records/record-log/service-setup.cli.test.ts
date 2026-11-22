import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId
} from '@/api/device-signing/app-device-grant';
import { main } from './service-setup.cli';
import { ServiceKeysFile } from './service-setup';

const API = 'https://api.example.test';

describe('records service setup command', () => {
  let dir: string;
  let output: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'records-setup-'));
    output = '';
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    process.env.WEB_APP_ORIGIN = 'https://web.example.test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.WEB_APP_ORIGIN;
    rmSync(dir, { recursive: true, force: true });
  });

  const readKeys = (path: string) =>
    JSON.parse(readFileSync(path, 'utf8')) as ServiceKeysFile;

  it('prints the usage', async () => {
    await main(['--help']);
    expect(output).toContain('new-keys --env staging|production');
  });

  it('writes new keys once and prints no secret', async () => {
    const file = join(dir, 'keys.json');
    await main(['new-keys', '--env', 'staging', '--out', file]);
    const keys = readKeys(file);
    expect(output).toContain(keys.public.SIGNED_RECORDS_SERVICE_WALLET);
    expect(output).toContain(keys.public.device_key);
    for (const secret of [
      keys.secret.service_wallet_private_key,
      keys.secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED,
      ...JSON.parse(keys.secret.SIGNED_RECORDS_PROVIDER_KEYS).map(
        (key: { private_key: string }) => key.private_key
      )
    ]) {
      expect(output).not.toContain(secret.slice(2));
    }
    await expect(
      main(['new-keys', '--env', 'staging', '--out', file])
    ).rejects.toThrow('already exists');
    expect(readKeys(file)).toEqual(keys);
  });

  it('adds the grant to the same file', async () => {
    const file = join(dir, 'keys.json');
    await main(['new-keys', '--env', 'production', '--out', file]);
    const before = readKeys(file);
    jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const path = String(url).slice(`${API}/api`.length);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const reply = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (path.startsWith('/auth/session-nonce')) {
        return reply({ signable_message: 'm', server_signature: 's' });
      }
      if (path === '/auth/session-login') {
        return reply({ access_token: 't' });
      }
      if (path.startsWith('/identities/')) {
        return reply({ id: 'profile-id' });
      }
      return reply({
        id: computeAppDeviceGrantId(buildAppDeviceGrantMessage(body.grant))
      });
    });
    await main(['grant', '--keys', file, '--api', API, '--new-device-seed']);
    const after = readKeys(file);
    expect(after.public.SIGNED_RECORDS_SERVICE_PROFILE_ID).toBe('profile-id');
    expect(after.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toMatch(
      /^0x[0-9a-f]{64}$/
    );
    expect(after.public.device_key).not.toBe(before.public.device_key);
    expect(after.secret.service_wallet_private_key).toBe(
      before.secret.service_wallet_private_key
    );
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('prints the two config secrets ready to paste', async () => {
    const file = join(dir, 'keys.json');
    await main(['new-keys', '--env', 'staging', '--out', file]);
    const { secret } = readKeys(file);
    output = '';
    await main(['print-secrets', '--keys', file]);
    expect(output.split('\n')).toEqual([
      'SIGNED_RECORDS_SERVICE_DEVICE_SEED',
      secret.SIGNED_RECORDS_SERVICE_DEVICE_SEED,
      '',
      'SIGNED_RECORDS_PROVIDER_KEYS',
      secret.SIGNED_RECORDS_PROVIDER_KEYS,
      ''
    ]);
    expect(output).not.toContain('\\');
    expect(output).not.toContain(secret.service_wallet_private_key.slice(2));
  });

  it('refuses bad arguments', async () => {
    const file = join(dir, 'keys.json');
    await expect(main(['rotate'])).rejects.toThrow('Unknown command');
    await expect(main(['grant', '--keys', file])).rejects.toThrow(
      '"api" is required'
    );
    await expect(main(['grant', '--keys', file, '--api'])).rejects.toThrow(
      'Invalid arguments'
    );
    await expect(
      main(['new-keys', '--env', 'dev', '--out', file])
    ).rejects.toThrow('"env" must be one of');
    await expect(
      main(['revoke', '--keys', file, '--api', API, '--grant', '0x12'])
    ).rejects.toThrow('"grant"');
  });
});
