import {
  fetchAllPages,
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
    const urls: string[] = [];
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api/',
      minIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async (url) => {
        starts.push(clock.now());
        urls.push(url);
        clock.advance(20);
        return { status: 200, body: '{"ok":true}' };
      }
    });
    await Promise.all([
      client.getJson('/a', { x: 1, y: undefined }),
      client.getJson('b'),
      client.getJson('/c')
    ]);
    expect(urls).toEqual([
      'https://api.example/api/a?x=1',
      'https://api.example/api/b',
      'https://api.example/api/c'
    ]);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(500);
    }
    expect(client.requestCount).toBe(3);
  });

  it('retries 429 and 5xx, returns null on 404 and throws on other errors', async () => {
    const clock = fakeClock();
    const answers: HttpResponse[] = [
      { status: 429, body: '' },
      { status: 503, body: '' },
      { status: 200, body: '[1]' },
      { status: 404, body: '' },
      { status: 400, body: 'bad' }
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
    answers.push({ status: 400, body: 'dropped' });
    expect(await client.getJson('/w', {}, [400])).toBeNull();
    expect(clock.sleeps).toContain(1000);
    expect(clock.sleeps).toContain(2000);
  });

  it('refuses a base that is not http(s) and a file URL that is not https', async () => {
    expect(() => new PublicApiClient({ baseUrl: 'file:///x' })).toThrow();
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      httpGet: async () => ({ status: 200, body: '' })
    });
    await expect(client.getText('http://files.example/x')).rejects.toThrow(
      'non-https'
    );
  });

  it('reads every page until a short page', async () => {
    const clock = fakeClock();
    const client = new PublicApiClient({
      baseUrl: 'https://api.example/api',
      now: clock.now,
      sleep: clock.sleep,
      httpGet: async (url) => {
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
