// The real file system, with the server's two file calls watched.
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync)
  };
});

import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { serveSeedFiles } from './seed-files-server.fixture';

/** A GET with the path sent as written: no client normalises it. */
function get(
  port: number,
  requestPath: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      })
      .on('error', reject);
  });
}

describe('serveSeedFiles', () => {
  let base: string;
  let dir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-files-'));
    dir = path.join(base, 'files');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'abc123'), 'inside');
    fs.writeFileSync(path.join(base, 'outside'), 'secret');
    server = await serveSeedFiles(dir);
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('serves a file of the directory by its name, under any prefix', async () => {
    jest.mocked(fs.readFileSync).mockClear();
    expect(await get(port, '/abc123')).toEqual({ status: 200, body: 'inside' });
    expect(await get(port, '/ipfs/abc123')).toEqual({
      status: 200,
      body: 'inside'
    });
    // The watch sees the server's reads, so the next test's none means none.
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('refuses a path out of the directory, plain or encoded, and reads nothing', async () => {
    jest.mocked(fs.existsSync).mockClear();
    jest.mocked(fs.readFileSync).mockClear();
    for (const requestPath of [
      '/../outside',
      '/..%2Foutside',
      '/%2e%2e%2foutside',
      '/%2E%2E%5Coutside',
      '/..',
      '/%2e%2e',
      '/%E0%A4%A',
      '/missing'
    ]) {
      expect(await get(port, requestPath)).toEqual({ status: 404, body: '' });
    }
    expect(fs.readFileSync).not.toHaveBeenCalled();
    // Its lookups, for /../outside and /missing, stay inside the directory.
    for (const [looked] of jest.mocked(fs.existsSync).mock.calls) {
      expect(String(looked).startsWith(dir + path.sep)).toBe(true);
    }
  });
});
