import { compareText } from './p28';
import { FetchRefusedError, RateLimitedFetcher } from './rate-limited-fetcher';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly at: number;
}

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    }
  };
}

function fakeFetch(
  answers: Record<string, () => Response>,
  calls: Call[],
  clock: { now: () => number }
) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init, at: clock.now() });
    const answer = answers[url];
    return answer ? answer() : new Response('nope', { status: 404 });
  };
}

describe('RateLimitedFetcher', () => {
  it('sends one request at a time, at most two a second', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const f = new RateLimitedFetcher({
      allowedHosts: ['api.example'],
      ...clock,
      fetchFn: fakeFetch(
        { 'https://api.example/a': () => new Response('{"x":1}') },
        calls,
        clock
      )
    });
    await Promise.all([
      f.get('https://api.example/a'),
      f.get('https://api.example/a'),
      f.get('https://api.example/a'),
      f.get('https://api.example/a')
    ]);
    expect(calls).toHaveLength(4);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(500);
    }
    expect(f.log).toHaveLength(4);
    expect(f.log[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends no credentials', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const f = new RateLimitedFetcher({
      allowedHosts: ['api.example'],
      ...clock,
      fetchFn: fakeFetch(
        { 'https://api.example/a': () => new Response('') },
        calls,
        clock
      )
    });
    await f.get('https://api.example/a');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).sort(compareText)).toEqual([
      'Accept',
      'User-Agent'
    ]);
    expect(calls[0].init.credentials).toBe('omit');
    await expect(f.get('https://user:pw@api.example/a')).rejects.toThrow(
      FetchRefusedError
    );
  });

  it('refuses hosts off the list, plain http, and redirects off the list', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const f = new RateLimitedFetcher({
      allowedHosts: ['api.example', 'arweave.net'],
      httpHosts: ['devnet.example'],
      ...clock,
      fetchFn: fakeFetch(
        {
          'https://api.example/away': () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://elsewhere.example/x' }
            }),
          'https://arweave.net/id': () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://sandbox.arweave.net/id' }
            }),
          'https://sandbox.arweave.net/id': () => new Response('csv')
        },
        calls,
        clock
      )
    });
    await expect(f.get('https://elsewhere.example/x')).rejects.toThrow(
      FetchRefusedError
    );
    await expect(f.get('http://api.example/x')).rejects.toThrow(
      FetchRefusedError
    );
    await expect(f.get('http://devnet.example/x')).rejects.toThrow(
      FetchRefusedError
    );
    await expect(f.get('https://api.example/away')).rejects.toThrow(
      FetchRefusedError
    );
    const ok = await f.get('https://arweave.net/id');
    expect(ok.url).toBe('https://sandbox.arweave.net/id');
    expect(Buffer.from(ok.body).toString()).toBe('csv');
  });

  it('allows plain http only to a named host', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const f = new RateLimitedFetcher({
      allowedHosts: ['devnet.example'],
      httpHosts: ['devnet.example'],
      ...clock,
      fetchFn: fakeFetch(
        { 'http://devnet.example/x': () => new Response('ok') },
        calls,
        clock
      )
    });
    expect((await f.get('http://devnet.example/x')).status).toBe(200);
  });

  it('retries 429 and 5xx a few times, paced', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    let n = 0;
    const f = new RateLimitedFetcher({
      allowedHosts: ['api.example'],
      retries: 2,
      ...clock,
      fetchFn: fakeFetch(
        {
          'https://api.example/busy': () =>
            new Response('', { status: ++n < 3 ? 429 : 200 })
        },
        calls,
        clock
      )
    });
    expect((await f.get('https://api.example/busy')).status).toBe(200);
    expect(calls).toHaveLength(3);
    n = -10;
    expect((await f.get('https://api.example/busy')).status).toBe(429);
  });

  it("waits as long as the answer's Retry-After says, up to 10 s", async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    let n = 0;
    const f = new RateLimitedFetcher({
      allowedHosts: ['api.example'],
      retries: 2,
      minIntervalMs: 0,
      ...clock,
      fetchFn: fakeFetch(
        {
          'https://api.example/starting': () =>
            ++n === 1
              ? new Response('', {
                  status: 503,
                  headers: { 'Retry-After': '4' }
                })
              : n === 2
                ? new Response('', {
                    status: 503,
                    headers: { 'Retry-After': '120' }
                  })
                : new Response('ok')
        },
        calls,
        clock
      )
    });
    expect((await f.get('https://api.example/starting')).status).toBe(200);
    expect(calls.map((c) => c.at - calls[0].at)).toEqual([0, 4000, 14_000]);
  });

  it('posts JSON for an RPC read', async () => {
    const clock = fakeClock();
    const calls: Call[] = [];
    const f = new RateLimitedFetcher({
      allowedHosts: ['rpc.example'],
      ...clock,
      fetchFn: fakeFetch(
        { 'https://rpc.example/v2/secret-key': () => new Response('{}') },
        calls,
        clock
      )
    });
    await f.postJson('https://rpc.example/v2/secret-key', { a: 1 });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(f.log[0].url).toBe('https://rpc.example');
  });
});
