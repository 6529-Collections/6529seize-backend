import { fetchOpenSeaPricePage } from '@/marketStatsLoop/opensea-price-fetch';
import { Time } from '@/time';
import { getRedisClient } from '@/redis';

jest.mock('@/redis', () => ({ getRedisClient: jest.fn() }));

jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: (max: number) => Math.floor(max / 2)
}));

const url =
  'https://api.opensea.io/api/v2/offers/collection/test/all?next=page2';
const transportError = Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connection timed out'), {
    code: 'UND_ERR_CONNECT_TIMEOUT'
  })
});

describe('OpenSea price requests', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const delays: number[] = [];

  beforeEach(() => {
    jest.mocked(getRedisClient).mockReturnValue({
      eval: jest.fn().mockResolvedValue(0)
    } as unknown as ReturnType<typeof getRedisClient>);
    fetchMock = jest.spyOn(global, 'fetch');
    delays.length = 0;
    jest.spyOn(Time.prototype, 'sleep').mockImplementation(async function (
      this: Time
    ) {
      delays.push(this.toMillis());
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function request(deadlineMs = Date.now() + 600000) {
    return fetchOpenSeaPricePage(url, deadlineMs);
  }

  it('recovers from a nested connection timeout and retains exponential backoff', async () => {
    fetchMock
      .mockRejectedValueOnce(transportError)
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(Response.json({ offers: [] }));

    await expect(request()).resolves.toEqual({ offers: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1500, 3000]);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'retries HTTP %i and releases its response body',
    async (status) => {
      const response = new Response('unavailable', { status });
      const cancel = jest.spyOn(response.body!, 'cancel');
      fetchMock
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(Response.json({ offers: [] }));

      await expect(request()).resolves.toEqual({ offers: [] });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([400, 401, 403, 404, 501])(
    'fails immediately on permanent HTTP %i',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('failure', { status }));

      await expect(request()).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    }
  );

  it.each([
    new TypeError('invalid request option'),
    Object.assign(new Error('certificate expired'), {
      code: 'CERT_HAS_EXPIRED'
    }),
    Object.assign(new Error('host not found'), { code: 'ENOTFOUND' })
  ])(
    'does not retry permanent transport/programming errors: %s',
    async (error) => {
      fetchMock.mockRejectedValueOnce(error);

      await expect(request()).rejects.toMatchObject({
        cause: { cause: error }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('fails after four attempts with the URL and original network cause', async () => {
    fetchMock.mockRejectedValue(transportError);

    await expect(request()).rejects.toMatchObject({
      message: expect.stringContaining(`after 4 attempt(s) for ${url}`),
      cause: { cause: transportError }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1500, 3000, 6000]);
  });

  it('fails after repeated HTTP throttling', async () => {
    fetchMock.mockImplementation(
      async () => new Response('throttled', { status: 429 })
    );

    await expect(request()).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['seconds', 'date'])(
    'honors a short Retry-After value: %s',
    async (format) => {
      const retryAfter =
        format === 'seconds' ? '7' : new Date(Date.now() + 7000).toUTCString();
      fetchMock
        .mockResolvedValueOnce(
          new Response('throttled', {
            status: 429,
            headers: { 'Retry-After': retryAfter }
          })
        )
        .mockResolvedValueOnce(Response.json({ offers: [] }));

      await expect(request()).resolves.toEqual({ offers: [] });
      expect(delays[0]).toBeGreaterThan(5000);
      expect(delays[0]).toBeLessThanOrEqual(7000);
    }
  );

  it('does not retry earlier than a long Retry-After requests', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('throttled', {
        status: 429,
        headers: { 'Retry-After': '120' }
      })
    );

    await expect(request()).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('fails on invalid JSON without returning null or retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json'));

    await expect(request()).rejects.toMatchObject({
      cause: { cause: { name: 'SyntaxError' } }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transport failure while downloading the response body', async () => {
    const response = Response.json({ offers: [] });
    jest.spyOn(response, 'json').mockRejectedValueOnce(
      Object.assign(new TypeError('terminated'), {
        cause: { code: 'UND_ERR_SOCKET' }
      })
    );
    fetchMock
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ offers: [] }));

    await expect(request()).resolves.toEqual({ offers: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['connection', 'body'])(
    'times out a stalled %s and recovers',
    async (phase) => {
      jest.useFakeTimers();
      try {
        fetchMock
          .mockImplementationOnce(async (_url, options) => {
            const stall = () =>
              new Promise<never>((_resolve, reject) => {
                options!.signal!.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError'))
                );
              });
            if (phase === 'connection') return stall();
            const response = Response.json({ offers: [] });
            jest.spyOn(response, 'json').mockImplementation(stall);
            return response;
          })
          .mockResolvedValueOnce(Response.json({ offers: [] }));

        const pending = expect(request()).resolves.toEqual({ offers: [] });
        await jest.advanceTimersByTimeAsync(15000);
        await pending;
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('does not start requests after the shared deadline', async () => {
    await expect(request(Date.now())).rejects.toThrow('deadline exceeded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shortens an in-flight request only to the remaining shared budget', async () => {
    jest.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      fetchMock.mockImplementationOnce(async (_url, options) => {
        requestSignal = options!.signal;
        return new Promise<never>((_resolve, reject) => {
          requestSignal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        });
      });

      const pending = expect(request(Date.now() + 1000)).rejects.toThrow(
        'deadline exceeded'
      );
      await jest.advanceTimersByTimeAsync(999);
      expect(requestSignal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(requestSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops retrying when the backoff would exceed the shared deadline', async () => {
    fetchMock.mockRejectedValue(transportError);

    await expect(request(Date.now() + 1000)).rejects.toThrow(
      'deadline exceeded'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
