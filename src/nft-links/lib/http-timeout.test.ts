import fetch, { Response } from 'node-fetch';
import { fetchTextWithTimeout, HttpError } from '@/nft-links/lib/http';
import { getNftLinkResolutionBudget } from '@/nft-links/resolution-budget';
import { Logger } from '@/logging';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn()
}));
jest.mock('@/env', () => ({ env: { getIntOrNull: () => null } }));
jest.mock('@/nft-links/resolution-budget', () => ({
  getNftLinkResolutionBudget: jest.fn()
}));
jest.mock('@/logging', () => {
  const logger = { info: jest.fn() };
  return { Logger: { get: () => logger } };
});

const fetchMock = jest.mocked(fetch);
const budgetMock = jest.mocked(getNftLinkResolutionBudget);
const infoMock = jest.mocked(Logger.get('NFT_LINK_HTTP').info);
const url = 'https://user:password@example.com/private-item?token=secret';
const options = {
  timeoutMs: 5000,
  diagnosticPurpose: 'superrare_metadata' as const
};
const abortError = Object.assign(new Error('synthetic abort'), {
  name: 'AbortError'
});

function waitForAbort() {
  fetchMock.mockImplementation(
    (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(abortError));
      })
  );
}

function diagnostic() {
  return JSON.parse(infoMock.mock.calls[0][0]);
}

describe('NFT metadata HTTP timeout diagnostics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
  });

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('allows a response slower than the former 1.8-second limit', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Response('{}')), 2500)
        )
    );
    const result = fetchTextWithTimeout(url, options);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(result).resolves.toBe('{}');
    expect(diagnostic()).toEqual({
      event: 'http_fetch_finished',
      purpose: 'superrare_metadata',
      hostname: 'example.com',
      timeout_ms: 5000,
      elapsed_ms: 2500,
      status: 200,
      outcome: 'success',
      cancellation: null
    });
    expect(infoMock.mock.calls[0][0]).not.toMatch(
      /password|private-item|secret|\n/
    );
  });

  it('aborts a stalled fetch at five seconds and rethrows the original error', async () => {
    waitForAbort();
    const result = fetchTextWithTimeout(url, options).catch((error) => error);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(abortError);
    expect(diagnostic()).toMatchObject({
      outcome: 'failure',
      cancellation: 'request_timeout',
      elapsed_ms: 5000
    });
  });

  it('honors earlier resolution cancellation and removes the listener', async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    budgetMock.mockReturnValue({
      check: jest.fn(),
      signal: controller.signal
    } as unknown as NonNullable<ReturnType<typeof getNftLinkResolutionBudget>>);
    waitForAbort();
    const result = fetchTextWithTimeout(url, options).catch((error) => error);
    await jest.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await result).toBe(abortError);
    expect(diagnostic()).toMatchObject({
      outcome: 'failure',
      cancellation: 'resolution_budget',
      elapsed_ms: 1000
    });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('preserves HTTP failure identity and records its status', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404, url }));
    const result = await fetchTextWithTimeout(url, options).catch(
      (error) => error
    );
    expect(result).toBeInstanceOf(HttpError);
    expect(result.responseMatchesRequest).toBe(true);
    expect(diagnostic()).toMatchObject({
      status: 404,
      outcome: 'failure',
      cancellation: null
    });
  });

  it('keeps the timeout active while reading the response body', async () => {
    fetchMock.mockImplementation(
      async (_url, opts) =>
        ({
          ok: true,
          status: 200,
          headers: new Map(),
          arrayBuffer: () =>
            new Promise((_resolve, reject) => {
              opts?.signal?.addEventListener('abort', () => reject(abortError));
            })
        }) as unknown as Response
    );
    const result = fetchTextWithTimeout(url, options).catch((error) => error);
    await jest.advanceTimersByTimeAsync(5000);
    expect(await result).toBe(abortError);
    expect(diagnostic()).toMatchObject({
      status: 200,
      outcome: 'failure',
      cancellation: 'request_timeout'
    });
  });

  it('does not add diagnostics for callers that did not opt in', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await fetchTextWithTimeout(url, { timeoutMs: 1800 });
    expect(infoMock).not.toHaveBeenCalled();
  });
});
