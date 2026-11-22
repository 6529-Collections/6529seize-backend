import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInGitWorkTree, main } from './service-setup.cli';
import { fakeSetupApi } from './service-setup-test-api';
import { ServiceKeysFile, SETUP_APIS } from './service-setup';

/** When set, a temporary file can't be created, as in a read-only folder. */
let mockFailTemporaryFiles = false;

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    openSync: (path: unknown, ...rest: unknown[]) => {
      if (mockFailTemporaryFiles && String(path).endsWith('.tmp')) {
        throw new Error('read-only');
      }
      return actual.openSync(path, ...rest);
    }
  };
});

describe('records service setup command', () => {
  let dir: string;
  let output: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'records-setup-'));
    output = '';
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    mockFailTemporaryFiles = false;
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readKeys = (path: string) =>
    JSON.parse(fs.readFileSync(path, 'utf8')) as ServiceKeysFile;

  const newKeysFile = async (environment = 'staging') => {
    const file = join(dir, `records-service-${environment}.json`);
    await main(['new-keys', '--env', environment, '--out', file]);
    output = '';
    return file;
  };

  /** Routes fetch to a fake staging API. */
  const fakeFetch = () => {
    const fake = fakeSetupApi({
      base: SETUP_APIS.staging.base,
      nowMs: Date.now()
    });
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url, init) => {
        const answer = await fake.fetchFn(String(url), init as any);
        return new Response(
          answer.status === 204 ? null : await answer.text(),
          { status: answer.status }
        );
      });
    return { fake, spy };
  };

  const tempFilesIn = (folder: string) =>
    fs.readdirSync(folder).filter((name) => name.endsWith('.tmp'));

  it('prints the usage', async () => {
    await main(['--help']);
    expect(output).toContain('new-keys --env staging|production');
  });

  it('writes new keys once and prints no secret', async () => {
    const file = join(dir, 'keys.json');
    await main(['new-keys', '--env', 'staging', '--out', file]);
    const keys = readKeys(file);
    expect(output).toContain(keys.public.SIGNED_RECORDS_SERVICE_WALLET);
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

  (process.platform === 'win32' ? it.skip : it)(
    'makes the keys file readable by its owner only',
    async () => {
      const file = await newKeysFile();
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  );

  it('refuses a keys file inside a git checkout', async () => {
    const repo = join(dir, 'repo');
    fs.mkdirSync(join(repo, '.git'), { recursive: true });
    fs.mkdirSync(join(repo, 'deep'));
    const file = join(repo, 'deep', 'keys.json');
    expect(isInGitWorkTree(file)).toBe(true);
    expect(isInGitWorkTree(join(dir, 'keys.json'))).toBe(false);
    await expect(
      main(['new-keys', '--env', 'staging', '--out', file])
    ).rejects.toThrow('must not be inside a git checkout');
    expect(fs.existsSync(file)).toBe(false);
    await expect(main(['print-secrets', '--keys', file])).rejects.toThrow(
      'must not be inside a git checkout'
    );
  });

  it('adds the grant to the same file, leaving no temporary file', async () => {
    const file = await newKeysFile();
    const before = readKeys(file);
    const { fake } = fakeFetch();
    await main(['grant', '--keys', file, '--handle', 'records_test']);
    const after = readKeys(file);
    expect(after.public.SIGNED_RECORDS_SERVICE_GRANT_ID).toBe(
      fake.grants[0].id
    );
    expect(after.secret).toEqual(before.secret);
    expect(tempFilesIn(dir)).toEqual([]);
    expect(output).toContain(fake.grants[0].id);
  });

  it('fails before any network call when the file cannot be replaced', async () => {
    const file = await newKeysFile();
    const { spy } = fakeFetch();
    mockFailTemporaryFiles = true;
    await expect(
      main(['grant', '--keys', file, '--handle', 'records_test'])
    ).rejects.toThrow('Cannot write next to');
    mockFailTemporaryFiles = false;
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes the temporary file on Ctrl-C', async () => {
    const file = await newKeysFile();
    const listeners = process.listenerCount('SIGINT');
    let answer: (response: Response) => void = () => undefined;
    jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    const exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const running = main(['grant', '--keys', file, '--handle', 'records_test']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(tempFilesIn(dir)).toHaveLength(1);
    (process.emit as (event: string, signal: string) => boolean)(
      'SIGINT',
      'SIGINT'
    );
    expect(exit).toHaveBeenCalledWith(130);
    expect(tempFilesIn(dir)).toEqual([]);
    answer(new Response('{"error":"down"}', { status: 500 }));
    await expect(running).rejects.toThrow('answered 500');
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    expect(tempFilesIn(dir)).toEqual([]);
  });

  it('removes the temporary file when the grant fails', async () => {
    const file = await newKeysFile();
    fakeFetch();
    await expect(main(['grant', '--keys', file])).rejects.toThrow(
      'pass --handle'
    );
    expect(tempFilesIn(dir)).toEqual([]);
  });

  it('lists and revokes the grants of the device key', async () => {
    const file = await newKeysFile();
    const { fake } = fakeFetch();
    await main(['grant', '--keys', file, '--handle', 'records_test']);
    output = '';
    await main(['list', '--keys', file]);
    expect(output).toContain(`${fake.grants[0].id}  this file's device key`);
    expect(output).toContain('active');
    output = '';
    await main(['revoke', '--keys', file, '--all-for-device']);
    expect(output).toBe(`Revoked ${fake.grants[0].id}\n`);
    expect(readKeys(file).public.revoked_grant_ids).toEqual([
      fake.grants[0].id
    ]);
    output = '';
    await main(['revoke', '--keys', file, '--all-for-device']);
    expect(output).toBe('No active grant to revoke\n');
  });

  it('prints the two config secrets ready to paste', async () => {
    const file = await newKeysFile();
    const { secret } = readKeys(file);
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
    const file = await newKeysFile();
    await expect(main(['rotate'])).rejects.toThrow('Unknown command');
    await expect(main(['grant'])).rejects.toThrow('"keys" is required');
    await expect(main(['grant', '--keys'])).rejects.toThrow(
      'Invalid arguments'
    );
    await expect(
      main(['new-keys', '--env', 'dev', '--out', join(dir, 'x.json')])
    ).rejects.toThrow('"env" must be one of');
    await expect(main(['revoke', '--keys', file])).rejects.toThrow(
      'must contain at least one of'
    );
    await expect(
      main(['revoke', '--keys', file, '--grant', '0x12'])
    ).rejects.toThrow('"grant"');
    await expect(
      main(['grant', '--keys', join(dir, 'missing.json')])
    ).rejects.toThrow('Cannot read');
  });
});
