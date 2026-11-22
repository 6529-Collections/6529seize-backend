import {
  fetchAllPages,
  HttpRequest,
  HttpResponse,
  PublicApiClient
} from './public-api-client';

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps
  };
}

describe('PublicApiClient', () => {
  it('starts requests at least 500 ms apart and sends no credentials', async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const requests: HttpRequest[] = [];
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api/',
      minIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async (request) => {
        starts.push(clock.now());
        requests.push(request);
        clock.advance(20);
        return { status: 200, body: '{"ok":true}' };
      }
    });
    await Promise.all([
      client.getJson('/a', { x: 1, y: undefined }),
      client.getJson('b'),
      client.getJson('/c')
    ]);
    expect(requests.map((r) => r.url)).toEqual([
      'https://api.example/api/a?x=1',
      'https://api.example/api/b',
      'https://api.example/api/c'
    ]);
    for (const request of requests) {
      expect(request.headers).toEqual({
        accept: '*/*',
        'user-agent': 'subscriptions-parity'
      });
      const names = Object.keys(request.headers).map((h) => h.toLowerCase());
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('cookie');
    }
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(500);
    }
    expect(client.requestCount).toBe(3);
  });

  it('retries 429 and 5xx, returns null on listed statuses and throws on others', async () => {
    const clock = fakeClock();
    const answers: HttpResponse[] = [
      { status: 429, body: '' },
      { status: 503, body: '' },
      { status: 200, body: '[1]' },
      { status: 404, body: '' },
      { status: 400, body: 'bad' },
      { status: 400, body: 'dropped' }
    ];
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async () => answers.shift()!
    });
    expect(await client.getJson('/x')).toEqual([1]);
    expect(await client.getJson('/y')).toBeNull();
    await expect(client.getJson('/z')).rejects.toThrow('answered 400');
    expect(await client.getJson('/w', {}, [400])).toBeNull();
    expect(clock.sleeps).toContain(1000);
    expect(clock.sleeps).toContain(2000);
  });

  it('follows redirects to allowed hosts, each hop rate limited', async () => {
    const clock = fakeClock();
    const starts: Array<[string, number]> = [];
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      fileHosts: ['files.example'],
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async ({ url }) => {
        starts.push([url, clock.now()]);
        if (url === 'https://files.example/x') {
          return { status: 302, body: '', location: '//abc.files.example/x' };
        }
        return { status: 200, body: 'file' };
      }
    });
    expect(await client.getText('https://files.example/x')).toBe('file');
    expect(starts.map(([u]) => u)).toEqual([
      'https://files.example/x',
      'https://abc.files.example/x'
    ]);
    expect(starts[1][1] - starts[0][1]).toBeGreaterThanOrEqual(500);
    expect(client.requestCount).toBe(2);
  });

  it('refuses non-https and hosts outside the allow-list, redirects included', async () => {
    expect(
      () => new PublicApiClient({ baseUrl: 'http://api.example/api' })
    ).toThrow('https');
    const calls: string[] = [];
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      fileHosts: ['files.example'],
      httpGet: async ({ url }) => {
        calls.push(url);
        return {
          status: 302,
          body: '',
          location: 'https://elsewhere.example/x'
        };
      }
    });
    await expect(client.getText('http://files.example/x')).rejects.toThrow(
      'non-https'
    );
    await expect(client.getText('https://other.example/x')).rejects.toThrow(
      'allow-list'
    );
    await expect(client.getText('https://files.example/x')).rejects.toThrow(
      'allow-list'
    );
    expect(calls).toEqual(['https://files.example/x']);
  });

  it('reads every page until a short page', async () => {
    const clock = fakeClock();
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async ({ url }) => {
        const page = Number(/page=(\d+)/.exec(url)![1]);
        const data = page < 3 ? [page, page] : [page];
        return {
          status: 200,
          body: JSON.stringify({
            count: 5,
            page,
            next: page < 3 ? 'true' : null,
            data
          })
        };
      }
    });
    expect(await fetchAllPages<number>(client, '/list', {}, 2)).toEqual([
      1, 1, 2, 2, 3
    ]);
  });
});
