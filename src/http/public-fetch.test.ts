import * as http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Resolver } from 'node:dns/promises';
import {
  createPinnedLookup,
  parsePublicTargetUrl,
  PinnedAddress,
  publicFetch,
  PublicFetchTimeoutError,
  publicNetwork,
  PublicNetworkPolicyError,
  PublicResponseTooLargeError,
  resolvePublicTarget
} from './public-fetch';

const servers: http.Server[] = [];
const originalResolveTarget = publicNetwork.resolveTarget;

afterEach(async () => {
  jest.restoreAllMocks();
  publicNetwork.resolveTarget = originalResolveTarget;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/**
 * Owned fixture hosts (which do not exist in DNS) are pinned to the loopback
 * test server. Every other host goes through the real public-address guard.
 */
function pinFixtureHosts(...hosts: string[]) {
  publicNetwork.resolveTarget = async (url, options) => {
    const { hostname } = new URL(url);
    if (hosts.includes(hostname)) {
      return { hostname, address: '127.0.0.1', family: 4 } as PinnedAddress;
    }
    return await resolvePublicTarget(url, options);
  };
}

describe('parsePublicTargetUrl', () => {
  it.each([
    ['file:///etc/passwd', /Unsupported URL protocol/],
    ['ftp://example.com/a', /Unsupported URL protocol/],
    ['gopher://example.com/', /Unsupported URL protocol/],
    ['https://user:pass@example.com/a', /credentials/],
    ['https://user@example.com/a', /credentials/],
    ['not a url', /Invalid URL/]
  ])('rejects %s', (url, message) => {
    expect(() => parsePublicTargetUrl(url)).toThrow(message);
  });

  it('enforces https when requested', () => {
    expect(() =>
      parsePublicTargetUrl('http://example.com/a', { httpsOnly: true })
    ).toThrow(PublicNetworkPolicyError);
    expect(
      parsePublicTargetUrl('https://example.com/a', { httpsOnly: true }).host
    ).toBe('example.com');
  });
});

describe('resolvePublicTarget', () => {
  function answer(v4: string[], v6: string[] | { code: string }) {
    jest.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(v4 as never);
    const resolve6 = jest.spyOn(Resolver.prototype, 'resolve6');
    if (Array.isArray(v6)) resolve6.mockResolvedValue(v6 as never);
    else resolve6.mockRejectedValue(v6);
  }

  it('pins the first validated answer', async () => {
    answer(['93.184.216.34'], ['2606:2800:220:1:248:1893:25c8:1946']);
    await expect(resolvePublicTarget('https://example.com/x')).resolves.toEqual(
      {
        hostname: 'example.com',
        address: '93.184.216.34',
        family: 4
      }
    );
  });

  it.each([
    [['93.184.216.34'], ['::1']],
    [['93.184.216.34', '10.0.0.5'], []],
    [['169.254.169.254'], []],
    [[], ['fd00::1']],
    [[], ['::ffff:127.0.0.1']]
  ])('rejects when any answer is non-public (%j, %j)', async (v4, v6) => {
    answer(v4, v6);
    await expect(resolvePublicTarget('https://example.com/x')).rejects.toThrow(
      'private/local'
    );
  });

  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/'
  ])('rejects literal non-public address %s without DNS', async (url) => {
    const resolve4 = jest.spyOn(Resolver.prototype, 'resolve4');
    await expect(resolvePublicTarget(url)).rejects.toThrow('private/local');
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('reports a host without answers as a DNS failure', async () => {
    answer([], { code: 'ENODATA' });
    await expect(
      resolvePublicTarget('https://example.com/x')
    ).rejects.toMatchObject({ name: 'FetchError', code: 'ENOTFOUND' });
  });
});

describe('createPinnedLookup', () => {
  const pinned: PinnedAddress = {
    hostname: 'fixture.test',
    address: '93.184.216.34',
    family: 4
  };

  it('answers only for the validated host and family', () => {
    const lookup = createPinnedLookup(pinned);
    const callback = jest.fn();
    lookup('fixture.test', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '93.184.216.34', 4);
    lookup('fixture.test', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [
      { address: '93.184.216.34', family: 4 }
    ]);
    lookup('other.test', {}, callback);
    expect(callback.mock.lastCall?.[0]).toBeInstanceOf(Error);
    lookup('fixture.test', { family: 6 }, callback);
    expect(callback.mock.lastCall?.[0]).toBeInstanceOf(Error);
  });
});

describe('publicFetch', () => {
  it('connects to the pinned address for a host that DNS does not know', async () => {
    const port = await serve((_req, res) => res.end('pinned'));
    pinFixtureHosts('fixture.test');
    const result = await publicFetch(`http://fixture.test:${port}/a`, {
      maxBytes: 100,
      maxRedirects: 0
    });
    expect(result).toMatchObject({ status: 200, ok: true });
    expect(result.body.toString()).toBe('pinned');
  });

  it('follows validated redirects and strips credentials across origins', async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await serve((req, res) => {
      seen.push(req.headers);
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://other.test:${port}/final` });
        res.end();
        return;
      }
      res.end('done');
    });
    pinFixtureHosts('fixture.test', 'other.test');
    const result = await publicFetch(`http://fixture.test:${port}/start`, {
      maxBytes: 100,
      maxRedirects: 2,
      headers: { authorization: 'Bearer synthetic', 'user-agent': 'test' }
    });
    expect(result.finalUrl).toBe(`http://other.test:${port}/final`);
    expect(result.body.toString()).toBe('done');
    expect(seen[0].authorization).toBe('Bearer synthetic');
    expect(seen[1].authorization).toBeUndefined();
    expect(seen[1]['user-agent']).toBe('test');
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://10.0.0.1/',
    'file:///etc/passwd'
  ])('refuses a redirect to %s', async (target) => {
    let requests = 0;
    const port = await serve((_req, res) => {
      requests++;
      res.writeHead(301, { location: target });
      res.end();
    });
    pinFixtureHosts('fixture.test');
    await expect(
      publicFetch(`http://fixture.test:${port}/start`, {
        maxBytes: 100,
        maxRedirects: 3
      })
    ).rejects.toThrow(/private\/local|Unsupported URL protocol/);
    expect(requests).toBe(1);
  });

  it('refuses a plain-http redirect hop when https is required', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://example.com/next' });
      res.end();
    });
    // Only the owned first hop skips policy; the redirect hop gets the real one.
    pinFixtureHosts('fixture.test');
    await expect(
      publicFetch(`http://fixture.test:${port}/start`, {
        maxBytes: 100,
        maxRedirects: 1,
        httpsOnly: true
      })
    ).rejects.toThrow(/Unsupported URL protocol: http:/);
  });

  it('stops after the redirect limit', async () => {
    let requests = 0;
    const port = await serve((_req, res) => {
      requests++;
      res.writeHead(302, { location: `/loop-${requests}` });
      res.end();
    });
    pinFixtureHosts('fixture.test');
    await expect(
      publicFetch(`http://fixture.test:${port}/start`, {
        maxBytes: 100,
        maxRedirects: 2
      })
    ).rejects.toThrow('Too many redirects');
    expect(requests).toBe(3);
  });

  it.each([
    ['content-length', true],
    ['stream', false]
  ] as const)('enforces the byte cap by %s', async (mode, declare) => {
    const port = await serve((_req, res) => {
      res.writeHead(200, declare ? { 'content-length': '64' } : {});
      res.end(Buffer.alloc(64));
    });
    pinFixtureHosts('fixture.test');
    const error = await publicFetch(`http://fixture.test:${port}/big`, {
      maxBytes: 16,
      maxRedirects: 0
    }).catch((e) => e);
    expect(error).toBeInstanceOf(PublicResponseTooLargeError);
    expect(error).toMatchObject({ limitBytes: 16, mode });
  });

  it('returns no body for HEAD and for error statuses', async () => {
    const port = await serve((req, res) => {
      res.writeHead(req.method === 'HEAD' ? 200 : 404, {
        'content-type': 'image/png'
      });
      res.end(req.method === 'HEAD' ? undefined : 'missing');
    });
    pinFixtureHosts('fixture.test');
    const head = await publicFetch(`http://fixture.test:${port}/`, {
      method: 'HEAD',
      maxBytes: 0,
      maxRedirects: 0
    });
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(head.body.length).toBe(0);
    const missing = await publicFetch(`http://fixture.test:${port}/`, {
      maxBytes: 100,
      maxRedirects: 0
    });
    expect(missing).toMatchObject({ status: 404, ok: false });
    expect(missing.body.length).toBe(0);
  });

  it('applies the overall deadline to a stalled body', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });
    pinFixtureHosts('fixture.test');
    await expect(
      publicFetch(`http://fixture.test:${port}/slow`, {
        maxBytes: 100,
        maxRedirects: 0,
        timeoutMs: 50
      })
    ).rejects.toBeInstanceOf(PublicFetchTimeoutError);
  });
});
