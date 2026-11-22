import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import {
  connectTarget,
  installSourceGuard,
  isAllowedTarget,
  parseAllowedEndpoints,
  SourceViolation
} from '@/rebuild/guard/source-guard';

describe('source guard', () => {
  it('parses endpoints and treats localhost and ::1 as 127.0.0.1', () => {
    const allowed = parseAllowedEndpoints(
      'localhost:3407, 127.0.0.1:9000,[::1]:9001,bad,host:0'
    );
    expect(Array.from(allowed).sort((a, b) => a.localeCompare(b))).toEqual([
      '127.0.0.1:3407',
      '127.0.0.1:9000',
      '127.0.0.1:9001'
    ]);
    expect(isAllowedTarget(allowed, { host: '::1', port: 9000 })).toBe(true);
    expect(isAllowedTarget(allowed, { host: '192.0.2.1', port: 3407 })).toBe(
      false
    );
    expect(isAllowedTarget(allowed, { path: '/tmp/socket' })).toBe(false);
  });

  it('reads every form of connect arguments', () => {
    expect(connectTarget([80, '192.0.2.1'])).toEqual({
      host: '192.0.2.1',
      port: 80
    });
    expect(
      connectTarget([[{ host: 'example.test', port: 443 }, null]])
    ).toEqual({ host: 'example.test', port: 443 });
    expect(connectTarget([{ port: 3407 }])).toEqual({
      host: 'localhost',
      port: 3407
    });
    expect(connectTarget(['/tmp/socket'])).toEqual({ path: '/tmp/socket' });
  });

  it('refuses a socket to a host outside the list and reports it', async () => {
    const violations: SourceViolation[] = [];
    const uninstall = installSourceGuard({
      allowed: parseAllowedEndpoints('127.0.0.1:1'),
      onViolation: (v) => violations.push(v)
    });
    try {
      const error = await new Promise<Error>((resolve) => {
        const socket = net.connect(80, '192.0.2.1');
        socket.on('error', resolve);
      });
      expect(error.message).toContain('192.0.2.1:80 is not an allowed source');
      expect(violations.map((v) => v.target)).toEqual(['192.0.2.1:80']);
    } finally {
      uninstall();
    }
  });

  it('lets an allowed loopback connection through', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const port = (server.address() as AddressInfo).port;
    const violations: SourceViolation[] = [];
    const uninstall = installSourceGuard({
      allowed: parseAllowedEndpoints(`127.0.0.1:${port}`),
      onViolation: (v) => violations.push(v)
    });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });
      expect(body).toBe('ok');
      expect(violations).toEqual([]);
    } finally {
      uninstall();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
