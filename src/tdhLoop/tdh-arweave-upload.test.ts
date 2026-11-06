import Arweave from 'arweave';
import Transaction from 'arweave/node/lib/transaction';
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
    const setSignature = Transaction.prototype.setSignature;
    let signed: ReturnType<Transaction['toJSON']> | undefined;
    jest
      .spyOn(Transaction.prototype, 'setSignature')
      .mockImplementation(function (
        this: Transaction,
        attributes: Parameters<Transaction['setSignature']>[0]
      ) {
        setSignature.call(this, attributes);
        signed = this.toJSON();
      });
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
    expect(signed).toBeDefined();
    expect(header).toEqual({ ...signed, data: '' });
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
      if (
        path(input) === '/chunk' &&
        new URL(String(input)).hostname === 'ardrive.net'
      ) {
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
    const headers = fetch.mock.calls.filter(([input]) => path(input) === '/tx');
    expect(headers).toHaveLength(2);
    expect(headers[0][1]!.body).toBe(headers[1][1]!.body);
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

  it('registers a fallback header once for concurrent chunks before sending their proofs', async () => {
    const fetch = setup();
    const registered = new Set<string>();
    const accepted = new Set<string>();
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      const gateway = new URL(String(input)).hostname;
      if (path(input) === '/tx') {
        registered.add(gateway);
        return new Response('');
      }
      if (gateway === 'ardrive.net') return new Response('{}', { status: 500 });
      if (!registered.has(gateway)) {
        return new Response('{"error":"data_root_not_found"}', { status: 400 });
      }
      accepted.add(JSON.parse(init!.body as string).offset);
      return new Response('');
    });
    await uploadTdhCsvToArweave('x'.repeat(2_300_000), key, logger);
    const headers = fetch.mock.calls.filter(([input]) => path(input) === '/tx');
    expect(headers.map(([input]) => new URL(String(input)).hostname)).toEqual([
      'ardrive.net',
      'turbo-gateway.com'
    ]);
    expect(headers[0][1]!.body).toBe(headers[1][1]!.body);
    expect(accepted.size).toBe(9);
    expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'coordinates all three gateways before concurrent chunks when the fallback header fails: %s',
    async (failHeader) => {
      const fetch = setup();
      const registered = new Set<string>();
      const offsets = new Map<string, number>();
      const accepted = new Set<string>();
      fetch.mockImplementation(async (input, init) => {
        if (init?.method === 'GET') return metadata(input);
        const gateway = new URL(String(input)).hostname;
        if (path(input) === '/tx') {
          // Keep registration pending while multiple workers await the same promise.
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (gateway === 'turbo-gateway.com' && failHeader)
            return new Response('{}', { status: 503 });
          registered.add(gateway);
          return new Response('');
        }
        expect(registered.has(gateway)).toBe(true);
        const offset: string = JSON.parse(init!.body as string).offset;
        if (!offsets.has(offset)) offsets.set(offset, offsets.size);
        if (
          gateway === 'ardrive.net' ||
          (gateway === 'turbo-gateway.com' && offsets.get(offset)! % 2 === 0)
        )
          return new Response('{}', { status: 500 });
        accepted.add(offset);
        return new Response('');
      });
      await uploadTdhCsvToArweave('x'.repeat(2_300_000), key, logger);
      const headers = fetch.mock.calls.filter(
        ([input]) => path(input) === '/tx'
      );
      expect(headers.map(([input]) => new URL(String(input)).hostname)).toEqual(
        ['ardrive.net', 'turbo-gateway.com', 'arweave.net']
      );
      expect(new Set(headers.map(([, init]) => init!.body)).size).toBe(1);
      expect(accepted.size).toBe(9);
      expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
      if (failHeader)
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(
            /GATEWAY turbo-gateway.com.*OP POST tx.*STATUS 503/
          )
        );
    }
  );

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

  it.each([
    [
      JSON.stringify({
        successCount: 0,
        failureCount: 7,
        results: Array.from({ length: 7 }, () => ({
          peer: 'http://peer-private-marker:1984',
          statusCode: 400,
          success: false
        }))
      }),
      'peer_upload_failed:success_0:failure_7:statuses_400'
    ],
    [JSON.stringify('data_root_not_found'), 'data_root_not_found']
  ])(
    'fails over a gateway HTTP 400 response with diagnostic %s',
    async (body, code) => {
      const fetch = setup();
      fetch.mockImplementation(async (input, init) => {
        if (init?.method === 'GET') return metadata(input);
        return path(input) === '/chunk' &&
          new URL(String(input)).hostname === 'ardrive.net'
          ? new Response(body, { status: 400 })
          : new Response('');
      });
      await uploadTdhCsvToArweave('CSV', key, logger);
      const chunks = fetch.mock.calls.filter(
        ([input]) => path(input) === '/chunk'
      );
      expect(chunks.map(([input]) => new URL(String(input)).hostname)).toEqual([
        'ardrive.net',
        'turbo-gateway.com'
      ]);
      expect(chunks[0][1]!.body).toBe(chunks[1][1]!.body);
      expect(Arweave.crypto.sign).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(code));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
        'peer-private-marker'
      );
    }
  );

  it('cancels retry backoff when the overall upload deadline expires', async () => {
    jest.useFakeTimers();
    const fetch = setup();
    let signing!: () => void;
    const signReady = new Promise<void>((resolve) => {
      signing = resolve;
    });
    jest.mocked(Arweave.crypto.sign).mockImplementation(async () => {
      signing();
      return new Promise((resolve) =>
        setTimeout(() => resolve(new Uint8Array(512).fill(1)), 90_000)
      );
    });
    let chunk!: () => void;
    const chunkReady = new Promise<void>((resolve) => {
      chunk = resolve;
    });
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      if (path(input) === '/chunk') {
        chunk();
        return new Response('{}', { status: 500 });
      }
      return new Response('');
    });
    const outcome = uploadTdhCsvToArweave('CSV', key, logger).catch(
      (error: unknown) => error
    );
    await signReady;
    await jest.advanceTimersByTimeAsync(90_000);
    await chunkReady;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: 'TDH Arweave upload exceeded 120000ms deadline'
      })
    );
    const calls = fetch.mock.calls.length;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it.each([400, 408, 429, 500, 503])(
    'bounds transient HTTP %s failures to two attempts per gateway',
    async (status) => {
      jest.useFakeTimers();
      const fetch = setup();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      fetch.mockImplementation(async (input, init) => {
        if (init?.method === 'GET') return metadata(input);
        if (path(input) === '/chunk') started();
        return path(input) === '/chunk'
          ? new Response('{}', { status })
          : new Response('');
      });
      const outcome = uploadTdhCsvToArweave('CSV', key, logger).catch(
        (error: unknown) => error
      );
      await ready;
      await jest.advanceTimersByTimeAsync(120001);
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('Arweave request failed')
        })
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

  it.each([
    'invalid_json',
    'chunk_too_big',
    'data_path_too_big',
    'offset_too_big',
    'data_size_too_big',
    'chunk_proof_ratio_not_attractive',
    'invalid_proof'
  ])('fails immediately on the permanent protocol error %s', async (code) => {
    const fetch = setup();
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === 'GET') return metadata(input);
      return path(input) === '/chunk'
        ? new Response(JSON.stringify({ error: code }), { status: 400 })
        : new Response('');
    });
    await expect(uploadTdhCsvToArweave('CSV', key, logger)).rejects.toThrow(
      code
    );
    expect(
      fetch.mock.calls.filter(([input]) => path(input) === '/chunk')
    ).toHaveLength(1);
  });

  it('fails over metadata and rejects malformed successful responses before signing', async () => {
    const fetch = setup();
    fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).hostname === 'ardrive.net')
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
        .every(
          ([input]) => new URL(String(input)).hostname === 'turbo-gateway.com'
        )
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
      if (
        path(input) === '/chunk' &&
        new URL(String(input)).hostname === 'ardrive.net'
      ) {
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
