import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const AdmZip = require('adm-zip');
jest.mock('yauzl', () => {
  const { dirname } = require('node:path');
  const sdk = require.resolve('@contentauth/c2pa-node');
  return jest.requireActual(
    require.resolve('yauzl', { paths: [dirname(sdk)] })
  );
});
const { install, selectAsset } = require('../vendor/c2pa-node/postinstall.cjs');

const BINARY = Buffer.from('synthetic native bytes for installer tests');
const URL =
  'https://github.com/contentauth/c2pa-js/releases/download/%40contentauth/c2pa-node%400.9.5/c2pa-node_test-v0.9.5.zip';
const hash = (value: Buffer) =>
  createHash('sha256').update(value).digest('hex');

type Asset = {
  url: string;
  archive_sha256: string;
  archive_size: number;
  entry_name: string;
  native_sha256: string;
  native_size: number;
};

function archive(names = ['index.node']): Buffer {
  const zip = new AdmZip();
  for (const name of names) zip.addFile(name, BINARY);
  return zip.toBuffer();
}

function patchCentral(bytes: Buffer, offset: number, value: number, width = 4) {
  const copy = Buffer.from(bytes);
  const central = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (central < 0) throw new Error('Synthetic ZIP missing central directory');
  if (width === 2) copy.writeUInt16LE(value, central + offset);
  else copy.writeUInt32LE(value >>> 0, central + offset);
  return copy;
}

function traversalArchive(): Buffer {
  // adm-zip sanitizes dot segments when adding names. Patch both equal-length
  // local/central names afterwards so the fixture actually contains traversal.
  const bytes = archive(['xx/index.node']);
  const original = Buffer.from('xx/index.node');
  let count = 0;
  let offset = bytes.indexOf(original);
  while (offset !== -1) {
    bytes.write('../index.node', offset);
    count++;
    offset = bytes.indexOf(original, offset + original.length);
  }
  if (count !== 2) throw new Error('Expected local and central ZIP names');
  return bytes;
}

describe('pinned C2PA native installer', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      const relative = path.relative(tmpdir(), directory);
      if (
        path.isAbsolute(relative) ||
        relative.startsWith('..') ||
        !path.basename(directory).startsWith('c2pa-installer-')
      ) {
        throw new Error('Refusing to remove a non-fixture directory');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(bytes = archive(), changes: Partial<Asset> = {}) {
    const packageRoot = mkdtempSync(path.join(tmpdir(), 'c2pa-installer-'));
    directories.push(packageRoot);
    const asset: Asset = {
      url: URL,
      archive_sha256: hash(bytes),
      archive_size: bytes.length,
      entry_name: 'index.node',
      native_sha256: hash(BINARY),
      native_size: BINARY.length,
      ...changes
    };
    mkdirSync(path.join(packageRoot, 'scripts'));
    writeFileSync(
      path.join(packageRoot, 'scripts', 'native-assets.json'),
      JSON.stringify({ schema_version: 1, assets: { 'linux-x64': asset } })
    );
    const fetchImpl = jest.fn(async () => new Response(new Uint8Array(bytes)));
    const run = (options = {}) =>
      install({
        packageRoot,
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
        ...options
      });
    const destination = path.join(packageRoot, 'dist', 'index.node');
    return { packageRoot, asset, fetchImpl, run, destination };
  }

  function seedExisting(
    f: ReturnType<typeof fixture>,
    value = 'existing binary'
  ) {
    mkdirSync(path.dirname(f.destination), { recursive: true });
    writeFileSync(f.destination, value);
  }

  function expectClean(f: ReturnType<typeof fixture>, existing = true) {
    expect(readdirSync(path.join(f.packageRoot, 'dist'))).toEqual(
      existing ? ['index.node'] : []
    );
    if (existing)
      expect(readFileSync(f.destination, 'utf8')).toBe('existing binary');
  }

  it('installs the exact native bytes, removes temporary files, then uses verified cache', async () => {
    const f = fixture();
    seedExisting(f);
    await expect(f.run()).resolves.toEqual({ cached: false });
    expect(readFileSync(f.destination)).toEqual(BINARY);
    expect(readdirSync(path.dirname(f.destination))).toEqual(['index.node']);
    await expect(f.run()).resolves.toEqual({ cached: true });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not mistake same-size corrupt cached bytes for the pinned native binary', async () => {
    const f = fixture();
    seedExisting(f, 'x'.repeat(BINARY.length));
    await expect(f.run()).resolves.toEqual({ cached: false });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.destination)).toEqual(BINARY);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'installs verified native bytes readable by a different runtime user',
    async () => {
      const f = fixture();
      await expect(f.run()).resolves.toEqual({ cached: false });
      expect(statSync(f.destination).mode & 0o777).toBe(0o644);
      chmodSync(f.destination, 0o600);
      await expect(f.run()).resolves.toEqual({ cached: true });
      expect(statSync(f.destination).mode & 0o777).toBe(0o644);
    }
  );

  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64']
  ])('selects the pinned asset for %s-%s', (platform, arch) => {
    const { asset } = fixture();
    expect(
      selectAsset(
        { schema_version: 1, assets: { [`${platform}-${arch}`]: asset } },
        platform,
        arch
      )
    ).toBe(asset);
  });

  it('fails unsupported platforms without download or source compilation', async () => {
    const f = fixture();
    await expect(f.run({ platform: 'win32', arch: 'arm64' })).rejects.toThrow(
      'Unsupported'
    );
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(path.join(f.packageRoot, 'dist'))).toBe(false);
  });

  it.each([
    { url: 'https://example.com/native.zip' },
    { archive_size: 64 * 1024 * 1024 + 1 },
    { native_size: 256 * 1024 * 1024 + 1 },
    { entry_name: '../index.node' },
    { archive_sha256: 'invalid' }
  ])('rejects an invalid pin before download: %j', async (changes) => {
    const f = fixture(archive(), changes);
    await expect(f.run()).rejects.toThrow('Invalid');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong name', () => archive(['other.node'])],
    ['traversal', traversalArchive],
    ['multiple entries', () => archive(['index.node', 'other.node'])],
    ['empty archive', () => archive([])],
    ['symbolic link', () => patchCentral(archive(), 38, 0o120777 << 16)],
    ['directory type', () => patchCentral(archive(), 38, 0o040755 << 16)],
    ['device type', () => patchCentral(archive(), 38, 0o020666 << 16)],
    ['DOS directory', () => patchCentral(archive(), 38, 0x10)],
    ['encrypted entry', () => patchCentral(archive(), 8, 1, 2)],
    ['unsupported compression', () => patchCentral(archive(), 10, 99, 2)],
    ['wrong native size', () => patchCentral(archive(), 24, BINARY.length + 1)],
    ['corrupt archive', () => Buffer.from('not a ZIP archive')]
  ])(
    'rejects %s and preserves the existing binary',
    async (_name, makeArchive) => {
      const f = fixture((makeArchive as () => Buffer)());
      seedExisting(f);
      await expect(f.run()).rejects.toThrow();
      expectClean(f);
    }
  );

  it('accepts the actual Windows DOS regular-file attributes without Unix mode bits', async () => {
    const f = fixture(patchCentral(archive(), 38, 32));
    await expect(f.run()).resolves.toEqual({ cached: false });
    expect(readFileSync(f.destination)).toEqual(BINARY);
  });

  it('checks archive SHA256 before attempting to parse corrupt ZIP bytes', async () => {
    const f = fixture(Buffer.from('not a ZIP'), {
      archive_sha256: '0'.repeat(64)
    });
    seedExisting(f);
    await expect(f.run()).rejects.toThrow('SHA256 mismatch');
    expectClean(f);
  });

  it('checks native SHA256 before replacing the existing file', async () => {
    const f = fixture(archive(), { native_sha256: '0'.repeat(64) });
    seedExisting(f);
    await expect(f.run()).rejects.toThrow('SHA256 mismatch');
    expectClean(f);
  });

  it.each([-1, 1])(
    'rejects actual archive bytes differing from pinned length by %s',
    async (delta) => {
      const bytes = archive();
      const f = fixture(bytes, { archive_size: bytes.length + delta });
      seedExisting(f);
      await expect(f.run()).rejects.toThrow(/size/i);
      expectClean(f);
    }
  );

  it('rejects a wrong Content-Length before consuming the body', async () => {
    const f = fixture();
    const cancel = jest.fn();
    const fetchImpl = jest.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'content-length': '999999' }
        })
    );
    seedExisting(f);
    await expect(f.run({ fetchImpl })).rejects.toThrow('download size');
    expect(cancel).toHaveBeenCalledTimes(1);
    expectClean(f);
  });

  it('allows the official release asset redirect with bounded manual redirects', async () => {
    const bytes = archive();
    const f = fixture(bytes);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/github-production-release-asset/1/native.zip?signature=synthetic'
          }
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    await expect(f.run({ fetchImpl })).resolves.toEqual({ cached: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });

  it.each([
    'https://example.com/native.zip',
    'http://release-assets.githubusercontent.com/native.zip',
    'https://release-assets.githubusercontent.com.evil.test/native.zip',
    'https://user:pass@release-assets.githubusercontent.com/native.zip'
  ])('refuses untrusted redirect %s', async (location) => {
    const f = fixture();
    const fetchImpl = jest.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location }
        })
    );
    seedExisting(f);
    await expect(f.run({ fetchImpl })).rejects.toThrow('Untrusted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expectClean(f);
  });

  it('bounds redirect loops and cleans up', async () => {
    const f = fixture();
    const fetchImpl = jest.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/loop'
          }
        })
    );
    seedExisting(f);
    await expect(f.run({ fetchImpl })).rejects.toThrow('redirect');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expectClean(f);
  });

  it('times out a stalled fetch and preserves the existing file', async () => {
    const f = fixture();
    const fetchImpl = jest.fn(
      (_url, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          });
        })
    );
    seedExisting(f);
    await expect(f.run({ fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      'timed out'
    );
    expectClean(f);
  });

  it('times out a stalled response stream and removes partial downloads', async () => {
    const f = fixture();
    const cancel = jest.fn();
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel
          })
        )
    );
    await expect(f.run({ fetchImpl, timeoutMs: 20 })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expectClean(f, false);
  });

  it('does not honor environment download or native-library skip switches', async () => {
    const f = fixture();
    const oldSkip = process.env.SKIP_BINARY_DOWNLOAD;
    const oldLibrary = process.env.C2PA_LIBRARY_PATH;
    process.env.SKIP_BINARY_DOWNLOAD = '1';
    process.env.C2PA_LIBRARY_PATH = '/synthetic/override.node';
    try {
      await expect(f.run()).resolves.toEqual({ cached: false });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (oldSkip === undefined) delete process.env.SKIP_BINARY_DOWNLOAD;
      else process.env.SKIP_BINARY_DOWNLOAD = oldSkip;
      if (oldLibrary === undefined) delete process.env.C2PA_LIBRARY_PATH;
      else process.env.C2PA_LIBRARY_PATH = oldLibrary;
    }
  });
});
