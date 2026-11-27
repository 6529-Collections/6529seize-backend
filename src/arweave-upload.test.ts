import { ArweaveUploadSession } from '@/arweave/upload';
import type { JWKInterface } from 'arweave/node/lib/wallet';
import Arweave from 'arweave';
import Transaction from 'arweave/node/lib/transaction';
import { ArweaveFileUploader, ArweaveUploadState } from '@/arweave';

const transactionId = 'a'.repeat(43);
const bytes = Buffer.from('original immutable publication');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const arweave = Arweave.init({ host: 'arweave.test', protocol: 'https' });
  const create = jest.spyOn(arweave, 'createTransaction').mockImplementation(
    async (input) =>
      new Transaction({
        data: input.data as Uint8Array,
        data_size: String((input.data as Uint8Array).byteLength),
        reward: '100',
        last_tx: 'test-anchor'
      })
  );
  const sign = jest
    .spyOn(arweave.transactions, 'sign')
    .mockImplementation(async (transaction) => {
      transaction.setSignature({
        id: transactionId,
        owner: 'public-owner',
        signature: 'public-signature'
      });
    });
  const post = jest.fn().mockImplementation(async () => new Response(''));
  const status = jest.fn().mockResolvedValue({ status: 404, confirmed: null });
  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname.slice(1);
    if (init?.method === 'POST') return post(path, init?.body);
    if (path.endsWith('/status')) {
      const result = await status(path.split('/')[1]);
      return new Response(
        result.status === 200
          ? JSON.stringify(
              result.confirmed ?? {
                block_indep_hash: 'b'.repeat(64),
                block_height: 1,
                number_of_confirmations: 1
              }
            )
          : '',
        { status: result.status }
      );
    }
    return new Response(path === 'tx_anchor' ? 'a'.repeat(43) : '100');
  });
  const uploader = new ArweaveFileUploader(() => ({
    arweave,
    key: { privateMarker: 'must-not-persist' }
  }));
  return { arweave, create, sign, post, status, uploader };
}

describe('durable Arweave uploads', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs and publishes caller tags through uploadFile', async () => {
    const { uploader, sign, post } = setup();
    const tags = { 'App-Name': '6529-subscriptions', Type: 'opening' };
    await uploader.uploadFile(bytes, 'application/json', tags);

    const transaction = sign.mock.calls[0][0];
    const decoded = Object.fromEntries(
      transaction.tags.map((tag) => [
        tag.get('name', { decode: true, string: true }),
        tag.get('value', { decode: true, string: true })
      ])
    );
    expect(decoded).toEqual({ 'Content-Type': 'application/json', ...tags });
    expect(JSON.parse(post.mock.calls[0][1]).tags).toEqual(
      transaction.toJSON().tags
    );
  });

  it('keeps caller tags in identical signed bytes across gateway retries', async () => {
    const { uploader, sign, post } = setup();
    post.mockRejectedValueOnce(new Error('header acknowledgment lost'));
    const states: ArweaveUploadState[] = [];
    await uploader.uploadFileWithTransactionId(
      bytes,
      'application/json',
      {
        onState: async (state) => {
          states.push(state);
        }
      },
      { 'App-Name': '6529-subscriptions', Type: 'history' }
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1]);
    expect(JSON.parse(post.mock.calls[1][1]).tags).toEqual(
      states[0].transaction.tags
    );
    expect(states[0].transaction.tags).toHaveLength(3);
  });

  it('resumes the original signed tags without replacing them or signing again', async () => {
    const { uploader, sign, create, post } = setup();
    const states: ArweaveUploadState[] = [];
    await uploader.uploadFileWithTransactionId(
      bytes,
      'application/json',
      {
        onState: async (state) => {
          states.push(state);
        }
      },
      { 'App-Name': '6529-subscriptions', Type: 'opening' }
    );
    const savedState = states[0];
    sign.mockClear();
    create.mockClear();
    post.mockClear();

    await uploader.uploadFileWithTransactionId(
      bytes,
      'application/json',
      { savedState, onState: async () => undefined },
      { 'App-Name': 'replacement-must-not-be-used' }
    );

    expect(create).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(JSON.parse(post.mock.calls[0][1]).tags).toEqual(
      savedState.transaction.tags
    );
  });

  it('preserves the existing uploadFile contract without checkpoint hooks', async () => {
    const { uploader, create, sign, post, status } = setup();
    const file = Buffer.from('prefix-original-file-suffix').subarray(7, 20);
    await expect(uploader.uploadFile(file, 'image/png')).resolves.toEqual({
      url: `https://arweave.net/${transactionId}`
    });
    expect(Buffer.from(create.mock.calls[0][0].data as Uint8Array)).toEqual(
      file
    );
    expect(sign).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('tx');
    expect(JSON.parse(post.mock.calls[0][1]).data).toBe(
      file.toString('base64url')
    );
    expect(status).not.toHaveBeenCalled();
  });

  it('persists the full signed transaction and original bytes before any submission', async () => {
    const { uploader, post } = setup();
    const states: ArweaveUploadState[] = [];
    const onState = jest.fn(async (state: ArweaveUploadState) => {
      if (states.length === 0) expect(post).not.toHaveBeenCalled();
      states.push(state);
    });
    await expect(
      uploader.uploadFileWithTransactionId(bytes, 'application/json', {
        onState
      })
    ).resolves.toEqual({
      url: `https://arweave.net/${transactionId}`,
      transaction_id: transactionId
    });
    expect(states[0]).toEqual(
      expect.objectContaining({
        txPosted: false,
        chunkIndex: 0,
        data_base64: bytes.toString('base64'),
        transaction: expect.objectContaining({
          id: transactionId,
          owner: 'public-owner',
          signature: 'public-signature'
        })
      })
    );
    expect(states[1].txPosted).toBe(true);
    expect(states[1].chunkIndex).toBe(1);
    expect(states).toHaveLength(2);
    expect(JSON.stringify(states)).not.toContain('must-not-persist');
    expect(states[0].txPosted).toBe(false);
  });

  it('does not submit if the initial durable checkpoint fails', async () => {
    const { uploader, post } = setup();
    await expect(
      uploader.uploadFileWithTransactionId(bytes, 'application/json', {
        onState: async () => {
          throw new Error('database unavailable');
        }
      })
    ).rejects.toThrow('database unavailable');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([200, 202])(
    'reuses the same transaction after an upload acknowledgement checkpoint is lost (%s)',
    async (postedStatus) => {
      const { uploader, create, sign, post, status } = setup();
      let savedState: ArweaveUploadState | undefined;
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'application/json', {
          onState: async (state) => {
            if (state.txPosted) throw new Error('checkpoint lost');
            savedState = state;
          }
        })
      ).rejects.toThrow('checkpoint lost');
      expect(savedState!.txPosted).toBe(false);
      expect(post.mock.calls.map(([url]) => url)).toEqual(['tx']);
      status.mockResolvedValue({ status: postedStatus, confirmed: null });
      const resumed: ArweaveUploadState[] = [];
      const result = await uploader.uploadFileWithTransactionId(
        Buffer.from('regenerated timestamp'),
        'application/json',
        {
          savedState,
          onState: async (state) => {
            resumed.push(state);
          }
        }
      );
      expect(result.transaction_id).toBe(transactionId);
      expect(create).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(status).toHaveBeenCalledWith(transactionId);
      expect(post.mock.calls.map(([url]) => url)).toEqual([
        'tx',
        'tx',
        'chunk'
      ]);
      expect(resumed[0].txPosted).toBe(true);
      expect(
        resumed.every((state) => state.data_base64 === bytes.toString('base64'))
      ).toBe(true);
    }
  );

  it('reposts the saved signed transaction when no previous submission is known', async () => {
    const { uploader, create, sign, post } = setup();
    let savedState: ArweaveUploadState | undefined;
    post.mockRejectedValue(new Error('network unavailable'));
    // The library logs provider errors; keep the synthetic failure out of test output.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      uploader.uploadFileWithTransactionId(bytes, 'application/json', {
        onState: async (state) => {
          savedState = state;
        }
      })
    ).rejects.toThrow('Arweave request failed');
    post.mockImplementation(async () => new Response(''));
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      savedState,
      onState: async () => undefined
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.filter(([url]) => url === 'tx')).toHaveLength(5);
    expect(post.mock.calls.at(-1)?.[0]).toBe('tx');
    expect(JSON.parse(post.mock.calls.at(-1)![1]).data).toBe(
      bytes.toString('base64url')
    );
  });

  it('returns the same completed transaction without another provider submission after receipt persistence fails', async () => {
    const { uploader, create, sign, post, status } = setup();
    let savedState: ArweaveUploadState | undefined;
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      onState: async (state) => {
        savedState = state;
      }
    });
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      savedState,
      onState: async () => undefined
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('resumes a multi-chunk upload and registers its original signed header before chunks', async () => {
    const { uploader, create, sign, post } = setup();
    const largeBytes = Buffer.alloc(600000, 7);
    let savedState: ArweaveUploadState | undefined;
    await expect(
      uploader.uploadFileWithTransactionId(largeBytes, 'application/json', {
        onState: async (state) => {
          if (state.chunkIndex === 2) throw new Error('chunk checkpoint lost');
          savedState = state;
        }
      })
    ).rejects.toThrow('chunk checkpoint lost');
    expect(savedState!.chunkIndex).toBe(1);
    expect(savedState!.txPosted).toBe(true);
    const checkpoints: number[] = [];
    await uploader.uploadFileWithTransactionId(largeBytes, 'application/json', {
      savedState,
      onState: async (state) => {
        checkpoints.push(state.chunkIndex);
      }
    });
    expect(checkpoints).toEqual([1, 2, 3]);
    expect(post.mock.calls.filter(([url]) => url === 'tx')).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatching persisted bytes before submitting a resumed transaction', async () => {
    const { uploader, post } = setup();
    let savedState: ArweaveUploadState | undefined;
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      onState: async (state) => {
        savedState = state;
      }
    });
    await expect(
      uploader.uploadFileWithTransactionId(bytes, 'application/json', {
        savedState: {
          ...savedState!,
          data_base64: Buffer.from('tampered').toString('base64')
        },
        onState: async () => undefined
      })
    ).rejects.toThrow('Data mismatch');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

it('resumes twice from the committed prefix and only replays chunks whose checkpoint was lost', async () => {
  const { uploader, create, sign, post } = setup();
  const input = Buffer.alloc(600000, 7);
  let savedState: ArweaveUploadState | undefined;
  const uploadUntil = async (failAt: number) => {
    await expect(
      uploader.uploadFileWithTransactionId(input, 'application/json', {
        savedState,
        onState: async (state) => {
          if (state.chunkIndex === failAt) throw new Error('checkpoint lost');
          savedState = state;
        }
      })
    ).rejects.toThrow('checkpoint lost');
  };
  try {
    await uploadUntil(2);
    expect(savedState!.chunkIndex).toBe(1);
    await uploadUntil(3);
    expect(savedState!.chunkIndex).toBe(2);
    await uploader.uploadFileWithTransactionId(input, 'application/json', {
      savedState,
      onState: async (state) => {
        savedState = state;
      }
    });
    expect(savedState!.chunkIndex).toBe(3);
    const chunks = post.mock.calls
      .filter(([path]) => path === 'chunk')
      .map(([, body]) => JSON.parse(body));
    expect(chunks).toHaveLength(5);
    expect(chunks[1]).toEqual(chunks[2]);
    expect(chunks[3]).toEqual(chunks[4]);
    expect(new Set(chunks.map((chunk) => chunk.offset)).size).toBe(3);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    const headers = post.mock.calls
      .filter(([path]) => path === 'tx')
      .map(([, body]) => body);
    expect(headers).toHaveLength(3);
    expect(new Set(headers).size).toBe(1);
  } finally {
    jest.restoreAllMocks();
  }
});

it('waits for a durable chunk checkpoint before starting the next chunk', async () => {
  const { uploader, post } = setup();
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const checkpoint = new Promise<void>((resolve) => {
    reached = resolve;
  });
  try {
    const result = uploader.uploadFileWithTransactionId(
      Buffer.alloc(600000, 7),
      'text/csv',
      {
        onState: async (state) => {
          if (state.chunkIndex === 1) {
            reached();
            await blocked;
          }
        }
      }
    );
    await checkpoint;
    expect(post.mock.calls.filter(([path]) => path === 'chunk')).toHaveLength(
      1
    );
    release();
    await result;
    expect(post.mock.calls.filter(([path]) => path === 'chunk')).toHaveLength(
      3
    );
  } finally {
    release?.();
    jest.restoreAllMocks();
  }
});

it.each(['header', 'stream'] as const)(
  'caps the resumed status probe by %s and recovers through another gateway',
  async (mode) => {
    const { uploader, sign, create, post } = setup();
    let savedState: ArweaveUploadState | undefined;
    const canceled = jest.fn();
    try {
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          onState: async (state) => {
            savedState = state;
            throw new Error('stop before submission');
          }
        })
      ).rejects.toThrow('stop before submission');
      expect(post).not.toHaveBeenCalled();
      const original = jest.mocked(global.fetch).getMockImplementation()!;
      jest.mocked(global.fetch).mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (!url.pathname.endsWith('/status')) return original(input, init);
        if (url.hostname !== 'ardrive.net')
          return new Response('', { status: 202 });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(131072));
          },
          cancel: canceled
        });
        return new Response(
          body,
          mode === 'header'
            ? { headers: { 'content-length': '131072' } }
            : undefined
        );
      });
      await uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
        savedState,
        onState: async () => undefined
      });
      expect(canceled).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(post.mock.calls.map(([path]) => path)).toEqual(['tx', 'chunk']);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

it.each(['default', 'supplied'] as const)(
  'cancels a resumed status probe for a %s client without changing its saved checkpoint',
  async (kind) => {
    const { uploader, arweave, create, sign, post } = setup();
    let savedState: ArweaveUploadState | undefined;
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    try {
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          onState: async (state) => {
            savedState = state;
            throw new Error('checkpoint only');
          }
        })
      ).rejects.toThrow('checkpoint only');
      const unchanged = JSON.stringify(savedState);
      const original = jest.mocked(global.fetch).getMockImplementation()!;
      let probeSignal: AbortSignal | undefined;
      jest.mocked(global.fetch).mockImplementation(async (input, init) => {
        if (!new URL(String(input)).pathname.endsWith('/status'))
          return original(input, init);
        probeSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          probeSignal?.addEventListener(
            'abort',
            () => reject(new Error('probe aborted')),
            { once: true }
          );
        });
      });
      const onState = jest.fn();
      await expect(
        new ArweaveUploadSession(
          logger,
          kind === 'supplied' ? arweave : undefined,
          30
        ).upload(bytes, {} as JWKInterface, 'text/plain', {
          savedState,
          onState
        })
      ).rejects.toThrow('deadline');
      expect(probeSignal?.aborted).toBe(true);
      expect(onState).not.toHaveBeenCalled();
      expect(JSON.stringify(savedState)).toBe(unchanged);
      expect(post).not.toHaveBeenCalled();
      jest
        .mocked(global.fetch)
        .mockImplementation(async (input, init) =>
          new URL(String(input)).pathname.endsWith('/status')
            ? new Response('', { status: 202 })
            : original(input, init)
        );
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          savedState,
          onState: async () => undefined
        })
      ).resolves.toMatchObject({ transaction_id: transactionId });
      expect(create).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

it.each([201, 202, 204, 208])(
  'does not checkpoint a chunk HTTP %s response; retries identical bytes until HTTP 200',
  async (statusCode) => {
    const { uploader, post, sign } = setup();
    const states: ArweaveUploadState[] = [];
    let savedState: ArweaveUploadState | undefined;
    let pending = true;
    try {
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          onState: async (state) => {
            savedState = state;
            throw new Error('checkpoint only');
          }
        })
      ).rejects.toThrow('checkpoint only');
      post.mockImplementation(async (path) => {
        if (path === 'tx') return new Response(null, { status: 208 });
        if (pending) {
          pending = false;
          expect(states.at(-1)?.chunkIndex).toBe(0);
          return new Response(null, { status: statusCode });
        }
        expect(states.at(-1)?.chunkIndex).toBe(0);
        return new Response('');
      });
      await uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
        savedState,
        onState: async (state) => {
          states.push(state);
        }
      });
      const chunks = post.mock.calls.filter(([path]) => path === 'chunk');
      expect(chunks).toHaveLength(2);
      expect(chunks[0][1]).toBe(chunks[1][1]);
      expect(states.map((state) => state.chunkIndex)).toEqual([0, 0, 1]);
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

it('publishes a new small file inline when both chunk endpoints are unavailable', async () => {
  const { uploader, post, sign } = setup();
  try {
    post.mockImplementation(
      async (path) => new Response('', { status: path === 'tx' ? 200 : 503 })
    );
    const states: ArweaveUploadState[] = [];
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      onState: async (state) => {
        states.push(state);
      }
    });
    expect(post.mock.calls.map(([path]) => path)).toEqual(['tx']);
    expect(JSON.parse(post.mock.calls[0][1]).data).toBe(
      bytes.toString('base64url')
    );
    expect(states.map((state) => [state.txPosted, state.chunkIndex])).toEqual([
      [false, 0],
      [true, 1]
    ]);
    expect(sign).toHaveBeenCalledTimes(1);
  } finally {
    jest.restoreAllMocks();
  }
});

it('replays the identical inline transaction across gateways after a lost acknowledgement', async () => {
  const { uploader, post, sign } = setup();
  try {
    post
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValue(new Response(''));
    await uploader.uploadFile(bytes, 'text/plain');
    expect(post.mock.calls.map(([path]) => path)).toEqual(['tx', 'tx']);
    expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1]);
    expect(
      jest
        .mocked(global.fetch)
        .mock.calls.filter(([, init]) => init?.method === 'POST')
        .map(([input]) => new URL(String(input)).hostname)
    ).toEqual(['ardrive.net', 'arweave.net']);
    expect(JSON.parse(post.mock.calls[1][1]).data).toBe(
      bytes.toString('base64url')
    );
    expect(sign).toHaveBeenCalledTimes(1);
  } finally {
    jest.restoreAllMocks();
  }
});

it.each([200, 208])(
  'resumes an unposted one-chunk checkpoint using its original inline bytes (HTTP %s)',
  async (statusCode) => {
    const { uploader, post, status, sign, create } = setup();
    let savedState: ArweaveUploadState | undefined;
    const states: ArweaveUploadState[] = [];
    try {
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          onState: async (state) => {
            savedState = state;
            throw new Error('process stopped after persistence');
          }
        })
      ).rejects.toThrow('process stopped');
      expect(post).not.toHaveBeenCalled();
      const saved = JSON.stringify(savedState);
      status.mockResolvedValue({ status: 404, confirmed: null });
      post.mockImplementation(
        async (path) =>
          new Response('', {
            status: path === 'tx' ? statusCode : statusCode === 200 ? 503 : 200
          })
      );
      await uploader.uploadFileWithTransactionId(
        Buffer.from('regenerated caller bytes'),
        'text/plain',
        {
          savedState,
          onState: async (state) => {
            states.push(state);
          }
        }
      );
      const inline = JSON.parse(post.mock.calls[0][1]);
      expect(inline.data).toBe(bytes.toString('base64url'));
      expect(inline.id).toBe(savedState!.transaction.id);
      expect(post.mock.calls.filter(([path]) => path === 'chunk')).toHaveLength(
        statusCode === 200 ? 0 : 1
      );
      expect(states.map((state) => [state.txPosted, state.chunkIndex])).toEqual(
        statusCode === 200
          ? [
              [false, 0],
              [true, 1]
            ]
          : [
              [false, 0],
              [true, 0],
              [true, 1]
            ]
      );
      expect(JSON.stringify(savedState)).toBe(saved);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

it('does not treat a duplicate-header HTTP 208 as proof of inline data acceptance', async () => {
  jest.useFakeTimers();
  const { uploader, post } = setup();
  const submitted = deferred<void>();
  const states: ArweaveUploadState[] = [];
  try {
    post.mockImplementation(async (path) => {
      submitted.resolve();
      return path === 'chunk'
        ? new Response('invalid_proof', { status: 400 })
        : new Response('', { status: 208 });
    });
    const upload = uploader
      .uploadFileWithTransactionId(bytes, 'text/plain', {
        onState: async (state) => {
          states.push(state);
        }
      })
      .catch((error) => error);
    await submitted.promise;
    await jest.advanceTimersByTimeAsync(2000);
    expect(await upload).toBeInstanceOf(Error);
    expect(states.every((state) => state.chunkIndex === 0)).toBe(true);
    expect(states.at(-1)?.txPosted).toBe(true);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

it.each([201, 202, 208])(
  'requires a chunk acknowledgement after ambiguous inline HTTP %s responses',
  async (status) => {
    jest.useFakeTimers();
    const { uploader, post, sign } = setup();
    const submitted = deferred<void>();
    const states: ArweaveUploadState[] = [];
    try {
      post.mockImplementation(async (path) => {
        submitted.resolve();
        return new Response('', { status: path === 'chunk' ? 200 : status });
      });
      const upload = uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
        onState: async (state) => {
          states.push(state);
        }
      });
      await submitted.promise;
      await jest.advanceTimersByTimeAsync(2000);
      await upload;
      expect(post.mock.calls.filter(([path]) => path === 'chunk')).toHaveLength(
        1
      );
      expect(states.map((state) => [state.txPosted, state.chunkIndex])).toEqual(
        [
          [false, 0],
          [true, 0],
          [true, 1]
        ]
      );
      const headers = post.mock.calls
        .filter(([path]) => path === 'tx')
        .map(([, body]) => JSON.parse(body));
      expect(new Set(headers.map((header) => header.id))).toEqual(
        new Set([transactionId])
      );
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  }
);

it.each([0, 1])(
  'bounds a stalled checkpoint at chunk %s and stops before further submission',
  async (chunkIndex) => {
    jest.useFakeTimers();
    const { arweave, post } = setup();
    const stalled = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    try {
      const upload = new ArweaveUploadSession(logger, arweave, 100)
        .upload(Buffer.alloc(600000, 7), {} as JWKInterface, 'text/plain', {
          onState: async (state, context) => {
            if (state.chunkIndex !== chunkIndex) return;
            signal = context.signal;
            stalled.resolve();
            await release.promise;
          }
        })
        .catch((error) => error);
      await stalled.promise;
      const submissions = post.mock.calls.length;
      await jest.advanceTimersByTimeAsync(101);
      expect(await upload).toMatchObject({
        message: 'Arweave upload exceeded 100ms deadline'
      });
      expect(signal?.aborted).toBe(true);
      release.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(submissions);
      expect(submissions).toBe(chunkIndex === 0 ? 0 : 2);
    } finally {
      release.resolve();
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  }
);

it.each([201, 208])(
  'rejects resume HTTP %s even when its body looks confirmed',
  async (statusCode) => {
    const { uploader, post, sign } = setup();
    let savedState: ArweaveUploadState | undefined;
    try {
      await expect(
        uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
          onState: async (state) => {
            savedState = state;
            throw new Error('checkpoint only');
          }
        })
      ).rejects.toThrow('checkpoint only');
      const original = jest.mocked(global.fetch).getMockImplementation()!;
      let probes = 0;
      jest.mocked(global.fetch).mockImplementation(async (input, init) => {
        if (!new URL(String(input)).pathname.endsWith('/status'))
          return original(input, init);
        probes++;
        return new Response(
          probes === 1
            ? JSON.stringify({
                block_height: 1,
                block_indep_hash: 'b'.repeat(64),
                number_of_confirmations: 1
              })
            : '',
          { status: probes === 1 ? statusCode : 202 }
        );
      });
      await uploader.uploadFileWithTransactionId(bytes, 'text/plain', {
        savedState,
        onState: async () => undefined
      });
      expect(probes).toBe(2);
      expect(post.mock.calls.map(([path]) => path)).toEqual(['tx', 'chunk']);
      expect(sign).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  }
);

it('re-registers a lost header without letting a stale worker discard the new registration', async () => {
  jest.useFakeTimers();
  const { uploader, sign } = setup();
  const original = jest.mocked(global.fetch).getMockImplementation()!;
  const firstWorkers = deferred<void>();
  const freshHeaderStarted = deferred<void>();
  const freshHeader = deferred<Response>();
  const initialChunks: ReturnType<typeof deferred<Response>>[] = [];
  const headers: string[] = [];
  const accepted = new Set<string>();
  try {
    jest.mocked(global.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== 'POST') return original(input, init);
      if (url.pathname === '/tx') {
        if (url.hostname !== 'ardrive.net') return new Response('');
        headers.push(init.body as string);
        if (headers.length === 1) return new Response('');
        freshHeaderStarted.resolve();
        return freshHeader.promise;
      }
      const chunk = init.body as string;
      if (url.hostname === 'ardrive.net' && initialChunks.length < 8) {
        const response = deferred<Response>();
        initialChunks.push(response);
        if (initialChunks.length === 8) firstWorkers.resolve();
        if (initialChunks.length === 1)
          return new Response('data_root_not_found', { status: 400 });
        const result = await response.promise;
        if (result.status === 200) accepted.add(chunk);
        return result;
      }
      accepted.add(chunk);
      return new Response('');
    });
    // Ten chunks: eight initial workers, then two workers share a replacement
    // registration while an older chunk response arrives late.
    const upload = uploader.uploadFile(
      Buffer.alloc(2_400_000, 7),
      'text/plain'
    );
    await firstWorkers.promise;
    await jest.advanceTimersByTimeAsync(0);
    initialChunks[2].resolve(new Response(''));
    await freshHeaderStarted.promise;
    initialChunks[1].resolve(
      new Response('data_root_not_found', { status: 400 })
    );
    await jest.advanceTimersByTimeAsync(0);
    for (const response of initialChunks.slice(3))
      response.resolve(new Response(''));
    await jest.advanceTimersByTimeAsync(0);
    expect(headers).toHaveLength(2);
    freshHeader.resolve(new Response(''));
    await jest.advanceTimersByTimeAsync(1000);
    await upload;
    expect(headers).toHaveLength(2);
    expect(new Set(headers).size).toBe(1);
    expect(accepted.size).toBe(10);
    expect(sign).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});
