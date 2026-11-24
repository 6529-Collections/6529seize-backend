import {
  withArweaveFallback,
  getArweaveFallbackUrls
} from '@/arweave-gateway-fallback';
import { recoverArweave, ArweaveTimeoutError } from '@/arweave/recovery';
import {
  PublicResponseTooLargeError,
  PublicNetworkPolicyError
} from '@/http/public-fetch';
import { parseDecentralizedMediaRef } from '@/decentralized-media/decentralized-media';

const id = 'A'.repeat(43);
const url = `https://media.6529.io/arweave/${id}/metadata.json`;
afterEach(() => jest.useRealTimers());

it('recovers the identical transaction/path from an alternative after a primary 404', async () => {
  const fetch = jest
    .fn()
    .mockRejectedValueOnce(new Error('HTTP 404'))
    .mockResolvedValue({ name: 'recovered' });
  await expect(withArweaveFallback(url, fetch)).resolves.toEqual({
    name: 'recovered'
  });
  expect(fetch.mock.calls[0][0]).toBe(url);
  expect(fetch.mock.calls[1][0]).toBe(
    `https://ardrive.net/${id}/metadata.json`
  );
  expect(fetch.mock.calls[0][1].aborted).toBe(true);
});

it('tries every candidate and preserves the final failure rather than reporting success', async () => {
  const error = new Error('all gateways unavailable');
  const fetch = jest.fn().mockRejectedValue(error);
  await expect(withArweaveFallback(url, fetch)).rejects.toBe(error);
  expect(fetch).toHaveBeenCalledTimes(
    new Set([url, ...getArweaveFallbackUrls(url)]).size
  );
});

it.each([
  new PublicResponseTooLargeError(30, 42, 'stream'),
  new PublicNetworkPolicyError('private destination')
])(
  'stops on policy rejection without retrying the same content elsewhere',
  async (error) => {
    const fetch = jest.fn().mockRejectedValue(error);
    await expect(withArweaveFallback(url, fetch)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

it('aborts a stalled gateway then recovers within one total budget', async () => {
  jest.useFakeTimers();
  try {
    let first: AbortSignal | undefined;
    const fetch = jest.fn(async (_url: string, signal: AbortSignal) => {
      if (!first) {
        first = signal;
        return new Promise<string>(() => undefined);
      }
      return 'ready';
    });
    const result = recoverArweave(
      ['https://one.example', 'https://two.example'],
      fetch,
      { timeoutMs: 90, attemptTimeoutMs: 30 }
    );
    await jest.advanceTimersByTimeAsync(31);
    await expect(result).resolves.toBe('ready');
    expect(first!.aborted).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

it('bounds all attempts together and cancels in-flight work', async () => {
  jest.useFakeTimers();
  try {
    const signals: AbortSignal[] = [];
    const outcome = recoverArweave(
      ['https://one.example', 'https://two.example', 'https://three.example'],
      async (_url, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
      { timeoutMs: 50, attemptTimeoutMs: 30 }
    ).catch((error) => error);
    await jest.advanceTimersByTimeAsync(51);
    expect(await outcome).toBeInstanceOf(ArweaveTimeoutError);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

it('recognizes retired inputs without offering broken hosts as active alternatives', () => {
  expect(parseDecentralizedMediaRef(`https://ar-io.net/${id}`)?.id).toBe(id);
  expect(
    getArweaveFallbackUrls(url).every(
      (candidate) => !/ar-io.net|turbo-gateway.com/.test(candidate)
    )
  ).toBe(true);
  expect(getArweaveFallbackUrls(`https://arweave.net/raw/${id}`)).toContain(
    `https://ardrive.net/${id}`
  );
});

it('cancels immediately with its parent and never starts a fallback afterwards', async () => {
  const controller = new AbortController();
  const reason = new Error('caller budget expired');
  let attemptSignal: AbortSignal | undefined;
  const fetch = jest.fn(async (_url: string, signal: AbortSignal) => {
    attemptSignal = signal;
    return new Promise(() => undefined);
  });
  const outcome = recoverArweave(
    ['https://one.example', 'https://two.example'],
    fetch,
    { signal: controller.signal }
  );
  controller.abort(reason);
  await expect(outcome).rejects.toBe(reason);
  expect(attemptSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(['?download=1', '#preview', '/asset.json?download=1'])(
  'recovers raw transaction URLs with suffix %s',
  async (suffix) => {
    const input = `https://arweave.net/raw/${id}${suffix}`;
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 404'))
      .mockResolvedValue('ready');
    await expect(withArweaveFallback(input, fetch)).resolves.toBe('ready');
    expect(fetch.mock.calls[0][0]).toBe(input);
    expect(fetch.mock.calls[1][0]).toBe(
      `https://ardrive.net/${id}${suffix.startsWith('/') ? '/asset.json' : ''}`
    );
  }
);
