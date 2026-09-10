import Arweave from 'arweave';
import Transaction from 'arweave/node/lib/transaction';
import { ArweaveFileUploader, ArweaveUploadState } from '@/arweave';

const transactionId = 'a'.repeat(43);
const bytes = Buffer.from('original immutable publication');

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
  const post = jest
    .spyOn(arweave.api, 'post')
    .mockResolvedValue({ status: 200, data: '' } as Awaited<
      ReturnType<typeof arweave.api.post>
    >);
  const status = jest
    .spyOn(arweave.transactions, 'getStatus')
    .mockResolvedValue({ status: 404, confirmed: null });
  const uploader = new ArweaveFileUploader(() => ({
    arweave,
    key: { privateMarker: 'must-not-persist' }
  }));
  return { arweave, create, sign, post, status, uploader };
}

describe('durable Arweave uploads', () => {
  afterEach(() => jest.restoreAllMocks());

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
      expect(post.mock.calls.map(([url]) => url)).toEqual(['tx', 'chunk']);
      expect(resumed[0].txPosted).toBe(true);
      expect(
        resumed.every((state) => state.data_base64 === bytes.toString('base64'))
      ).toBe(true);
    }
  );

  it('reposts the saved signed transaction when no previous submission is known', async () => {
    const { uploader, create, sign, post } = setup();
    let savedState: ArweaveUploadState | undefined;
    post.mockRejectedValueOnce(new Error('network unavailable'));
    // The library logs provider errors; keep the synthetic failure out of test output.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      uploader.uploadFileWithTransactionId(bytes, 'application/json', {
        onState: async (state) => {
          savedState = state;
        }
      })
    ).rejects.toThrow('Unable to upload transaction');
    await uploader.uploadFileWithTransactionId(bytes, 'application/json', {
      savedState,
      onState: async () => undefined
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(([url]) => url)).toEqual(['tx', 'tx']);
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

  it('resumes a multi-chunk upload from its last durable checkpoint without reposting the transaction', async () => {
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
    expect(post.mock.calls.filter(([url]) => url === 'tx')).toHaveLength(1);
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
