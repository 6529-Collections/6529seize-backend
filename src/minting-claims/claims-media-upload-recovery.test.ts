import { createHash } from 'node:crypto';
import { arweaveFileUploader, type ArweaveUploadState } from '@/arweave';
import { BadRequestException } from '@/exceptions';
import {
  ClaimMediaUploadRecovery,
  ClaimUploadYieldError,
  restoreClaimUploadState,
  type ClaimUploadRecoveryState
} from './claims-media-upload-recovery';

jest.mock('@/arweave', () => ({
  arweaveFileUploader: { uploadFileWithTransactionId: jest.fn() }
}));
const inputHash = 'b'.repeat(64);
const tx = 'a'.repeat(43);
const uploadState = (chunkIndex = 0): ArweaveUploadState => ({
  transaction: { id: tx },
  data_base64: '',
  chunkIndex,
  txPosted: true,
  lastRequestTimeEnd: 0,
  lastResponseStatus: 200,
  lastResponseError: ''
});

describe('claim upload durable recovery', () => {
  const upload = jest.mocked(arweaveFileUploader.uploadFileWithTransactionId);
  beforeEach(() => jest.resetAllMocks());

  function fixture(saved?: unknown) {
    const persisted: ClaimUploadRecoveryState[] = [];
    const persist = jest.fn(async (state: ClaimUploadRecoveryState) => {
      persisted.push(structuredClone(state));
    });
    const controller = new AbortController();
    const recovery = new ClaimMediaUploadRecovery(
      restoreClaimUploadState(saved, inputHash),
      persist,
      controller.signal
    );
    return { recovery, persisted, persist, controller };
  }

  it('persists the signed transaction before submission and resumes its acknowledged prefix', async () => {
    const first = fixture();
    upload.mockImplementationOnce(async (_bytes, _type, hooks) => {
      await hooks!.onState(uploadState(0), {
        signal: new AbortController().signal
      });
      expect(
        first.persisted.at(-1)!.files.animation!.upload!.transaction.id
      ).toBe(tx);
      await hooks!.onState(uploadState(735), {
        signal: new AbortController().signal
      });
      throw new Error('network failure');
    });
    await first.recovery.begin();
    await expect(
      first.recovery.publishFile(
        'animation',
        Buffer.from('original video'),
        'video/mp4',
        'https://s3.example/video'
      )
    ).rejects.toThrow('network failure');
    const next = fixture(first.persisted.at(-1));
    upload.mockImplementationOnce(async (bytes, _type, hooks) => {
      expect(bytes.toString()).toBe('original video');
      expect(hooks!.savedState!.chunkIndex).toBe(735);
      expect(hooks!.savedState!.transaction.id).toBe(tx);
      return { url: `https://arweave.net/${tx}`, transaction_id: tx };
    });
    await next.recovery.begin();
    await next.recovery.publishFile(
      'animation',
      Buffer.from('original video'),
      'video/mp4',
      'https://s3.example/video'
    );
    expect(next.recovery.state.failures).toBe(0);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('rejects changed source bytes before resuming any network upload', async () => {
    const f = fixture();
    upload.mockRejectedValueOnce(new Error('interrupted'));
    await expect(
      f.recovery.publishFile(
        'image',
        Buffer.from('original'),
        'image/png',
        'https://s3.example/image'
      )
    ).rejects.toThrow('interrupted');
    const next = fixture(f.persisted.at(-1));
    await expect(
      next.recovery.publishFile(
        'image',
        Buffer.from('changed'),
        'image/png',
        'https://s3.example/image'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('stops before submission if the first durable checkpoint fails', async () => {
    const f = fixture();
    f.persist.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      f.recovery.publishFile(
        'animation',
        Buffer.from('video'),
        'video/mp4',
        'source'
      )
    ).rejects.toThrow('database unavailable');
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps a 226 MB source out of checkpoint JSON', async () => {
    const f = fixture();
    const video = Buffer.alloc(226000000, 7);
    upload.mockImplementationOnce(async (bytes, _type, hooks) => {
      expect(bytes).toBe(video);
      await hooks!.onState(uploadState(1), {
        signal: new AbortController().signal
      });
      return { url: `https://arweave.net/${tx}`, transaction_id: tx };
    });
    await f.recovery.publishFile(
      'animation',
      video,
      'video/mp4',
      'existing-s3-url'
    );
    expect(JSON.stringify(f.persisted.at(-1)).length).toBeLessThan(5000);
    expect(f.recovery.state.files.animation!.sha256).toBe(
      createHash('sha256').update(video).digest('hex')
    );
  });

  it('resumes the exact metadata bytes even when regenerated metadata changes across a month boundary', async () => {
    const f = fixture();
    upload.mockRejectedValueOnce(new Error('receipt commit interrupted'));
    await expect(
      f.recovery.publishFile(
        'metadata',
        Buffer.from('{"month":"2026/11"}'),
        'application/json',
        'claim-metadata'
      )
    ).rejects.toThrow();
    const next = fixture(f.persisted.at(-1));
    upload.mockResolvedValueOnce({
      url: `https://arweave.net/${tx}`,
      transaction_id: tx
    });
    await next.recovery.publishFile(
      'metadata',
      Buffer.from('{"month":"2026/12"}'),
      'application/json',
      'claim-metadata'
    );
    expect(upload.mock.calls[1][0].toString()).toBe('{"month":"2026/11"}');
  });

  it('retains ownership while a cancelled checkpoint write is still in flight', async () => {
    const f = fixture();
    let settle!: () => void;
    const write = new Promise<void>((resolve) => {
      settle = resolve;
    });
    f.persist.mockImplementation(async (state) => {
      if (state.files.animation?.upload) await write;
    });
    upload.mockImplementationOnce(async (_bytes, _type, hooks) => {
      void hooks!.onState(uploadState(), { signal: f.controller.signal });
      await Promise.resolve();
      throw new ClaimUploadYieldError('handoff');
    });
    await expect(
      f.recovery.publishFile(
        'animation',
        Buffer.from('video'),
        'video/mp4',
        'source'
      )
    ).rejects.toThrow('handoff');
    let drained = false;
    const drain = f.recovery.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    settle();
    await drain;
    expect(drained).toBe(true);
  });

  it('charges a killed attempt without progress and rejects an exhausted recovery budget', async () => {
    const state = restoreClaimUploadState(null, inputHash);
    state.attemptActive = true;
    const f = fixture(state);
    await f.recovery.begin();
    expect(f.recovery.state.failures).toBe(1);
    f.recovery.state.failures = 10;
    await expect(f.recovery.begin()).rejects.toThrow('budget exhausted');
  });

  it('rejects malformed persisted state instead of signing a replacement', () => {
    expect(() => restoreClaimUploadState('{bad json', inputHash)).toThrow(
      'Invalid persisted'
    );
    expect(upload).not.toHaveBeenCalled();
  });
});
