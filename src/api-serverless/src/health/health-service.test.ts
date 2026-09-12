import fetch from 'node-fetch';
import { getIpfsHealth } from './health.service';

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../../logging', () => ({
  Logger: {
    get: () => ({ warn: jest.fn() })
  }
}));

const fetchMock = fetch as jest.MockedFunction<typeof fetch>;
const originalIpfsApiEndpoint = process.env.IPFS_API_ENDPOINT;

describe('IPFS health', () => {
  beforeEach(() => {
    jest.useRealTimers();
    fetchMock.mockReset();
    process.env.IPFS_API_ENDPOINT = 'https://api-ipfs.6529.io/';
  });

  afterAll(() => {
    if (originalIpfsApiEndpoint === undefined) {
      delete process.env.IPFS_API_ENDPOINT;
    } else {
      process.env.IPFS_API_ENDPOINT = originalIpfsApiEndpoint;
    }
  });

  it('reports healthy for a successful server-to-server response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(getIpfsHealth()).resolves.toEqual({ healthy: true });
    expect(fetchMock).toHaveBeenCalledWith('https://api-ipfs.6529.io/health', {
      headers: {
        Accept: 'application/json',
        'User-Agent': '6529-api-health/1.0'
      },
      signal: expect.any(AbortSignal)
    });
  });

  it('reports degraded for a non-success response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503
    } as Awaited<ReturnType<typeof fetch>>);

    await expect(getIpfsHealth()).resolves.toEqual({ healthy: false });
  });

  it('reports degraded when the endpoint is missing', async () => {
    delete process.env.IPFS_API_ENDPOINT;

    await expect(getIpfsHealth()).resolves.toEqual({ healthy: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports degraded when the request times out', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          })
      );

      const healthPromise = getIpfsHealth();
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(healthPromise).resolves.toEqual({ healthy: false });
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
