import Arweave from 'arweave';
import { JWKInterface } from 'arweave/node/lib/wallet';
import { uploadTdhCsvToArweave } from '@/tdhLoop/tdh-arweave-upload';

const key: JWKInterface = {
  kty: 'RSA',
  n: 'cHVibGljLW93bmVy',
  e: 'AQAB',
  d: 'private-marker',
  p: '',
  q: '',
  dp: '',
  dq: '',
  qi: ''
};
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const anchor = 'a'.repeat(43);

function path(input: string | URL | Request): string {
  return new URL(String(input)).pathname;
}

function metadata(input: string | URL | Request): Response {
  return new Response(path(input) === '/tx_anchor' ? anchor : '100');
}

function setup() {
  jest
    .spyOn(Arweave.crypto, 'sign')
    .mockResolvedValue(new Uint8Array(512).fill(1));
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (input, init) =>
      init?.method === 'GET' ? metadata(input) : new Response('')
    );
}

function hangingRequest(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error('transport aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('TDH Arweave gateway uploads', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('signs once, submits a metadata-only header, and uploads every chunk with its original data root', async () => {
    const fetch = setup();
    const csv = 'x'.repeat(600000);
    const result = await uploadTdhCsvToArweave(csv, key, logger);
    const posts = fetch.mock.calls.filter(
      ([, init]) => init?.method === 'POST'
    );
    const header = JSON.parse(posts[0][1]!.body as string);
    const chunks = posts
      .slice(1)
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(header.data).toBe('');
    expect(header.data_size).toBe('600000');
    expect(chunks).toHaveLength(3);
    expect(new Set(chunks.map((chunk) => chunk.offset)).size).toBe(3);
    expect(chunks.every((chunk) => chunk.data_root === header.data_root)).toBe(
      true
    );
    expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      url: `https://arweave.net/${header.id}`,
      transactionId: header.id
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[CHUNKS 3/3]')
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      'private-marker'
    );
  });

  it('fails over a gateway router crash without signing or posting a replacement transaction', async () => {
    const fetch = setup();
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      if (path(input) === '/chunk' && String(input).includes('ardrive.net')) {
        return new Response(
          JSON.stringify({
            details: '  function_clause',
            stacktrace: 'private upstream trace'
          }),
          { status: 500 }
        );
      }
      return new Response('');
    });
    await uploadTdhCsvToArweave('small CSV', key, logger);
    const chunkCalls = fetch.mock.calls.filter(
      ([input]) => path(input) === '/chunk'
    );
    expect(
      chunkCalls.map(([input]) => new URL(String(input)).hostname)
    ).toEqual(['ardrive.net', 'turbo-gateway.com']);
    expect(chunkCalls[0][1]!.body).toBe(chunkCalls[1][1]!.body);
    expect(
      fetch.mock.calls.filter(([input]) => path(input) === '/tx')
    ).toHaveLength(1);
    expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /GATEWAY ardrive.net.*CHUNK 0.*STATUS 500.*function_clause/
      )
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(
      /private-marker|private upstream trace/
    );
  });

  it('retries a lost header acknowledgement with the identical signed transaction', async () => {
    const fetch = setup();
    let failed = false;
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      if (path(input) === '/tx' && !failed) {
        failed = true;
        throw new Error('lost response');
      }
      return new Response('');
    });
    await uploadTdhCsvToArweave('CSV', key, logger);
    const headers = fetch.mock.calls.filter(([input]) => path(input) === '/tx');
    expect(headers).toHaveLength(2);
    expect(headers[0][1]!.body).toBe(headers[1][1]!.body);
    expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 503])(
    'bounds transient HTTP %s failures to two attempts per gateway',
    async (status) => {
      const fetch = setup();
      fetch.mockImplementation(async (input, init) => {
        if (init?.method === 'GET') return metadata(input);
        return path(input) === '/chunk'
          ? new Response('{}', { status })
          : new Response('');
      });
      await expect(uploadTdhCsvToArweave('CSV', key, logger)).rejects.toThrow(
        'Arweave request failed'
      );
      const gateways = fetch.mock.calls
        .filter(([input]) => path(input) === '/chunk')
        .map(([input]) => new URL(String(input)).hostname);
      expect(gateways).toEqual([
        'ardrive.net',
        'turbo-gateway.com',
        'arweave.net',
        'ardrive.net',
        'turbo-gateway.com',
        'arweave.net'
      ]);
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  );

  it('fails immediately on a permanent invalid-proof response', async () => {
    const fetch = setup();
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      return path(input) === '/chunk'
        ? new Response('{"error":"invalid_proof"}', { status: 400 })
        : new Response('');
    });
    await expect(uploadTdhCsvToArweave('CSV', key, logger)).rejects.toThrow(
      'invalid_proof'
    );
    expect(
      fetch.mock.calls.filter(([input]) => path(input) === '/chunk')
    ).toHaveLength(1);
  });

  it('fails over metadata and rejects malformed successful responses before signing', async () => {
    const fetch = setup();
    fetch.mockImplementation(async (input, init) => {
      if (String(input).includes('ardrive.net'))
        return new Response('<html>gateway error</html>');
      return init?.method === 'GET' ? metadata(input) : new Response('');
    });
    await uploadTdhCsvToArweave('CSV', key, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid_response')
    );
    expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls
        .filter(([input]) => path(input) === '/tx')
        .every(([input]) => String(input).includes('turbo-gateway.com'))
    ).toBe(true);
  });

  it('aborts a hung request after ten seconds and continues through another gateway', async () => {
    jest.useFakeTimers();
    const fetch = setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let firstSignal: AbortSignal | null | undefined;
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      if (path(input) === '/chunk' && String(input).includes('ardrive.net')) {
        firstSignal = init?.signal;
        started();
        return hangingRequest(init?.signal);
      }
      return new Response('');
    });
    const upload = uploadTdhCsvToArweave('CSV', key, logger);
    await ready;
    await jest.advanceTimersByTimeAsync(10250);
    await upload;
    expect(firstSignal?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('request_timeout')
    );
  });

  it('limits concurrent chunks to eight and aborts all workers at the overall upload deadline', async () => {
    jest.useFakeTimers();
    const fetch = setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let active = 0;
    let peak = 0;
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      if (path(input) !== '/chunk') return new Response('');
      active++;
      peak = Math.max(peak, active);
      if (active === 8) started();
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 9000);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            },
            { once: true }
          );
        });
        return new Response('');
      } finally {
        active--;
      }
    });
    const upload = uploadTdhCsvToArweave('x'.repeat(40_000_000), key, logger);
    const outcome = upload.catch((error: unknown) => error);
    await ready;
    await jest.advanceTimersByTimeAsync(120001);
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: 'TDH Arweave upload exceeded 120000ms deadline'
      })
    );
    expect(peak).toBe(8);
    expect(active).toBe(0);
    const calls = fetch.mock.calls.length;
    await jest.advanceTimersByTimeAsync(20000);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
