import { mintLogRecorder } from '@/mint-log/mint-log-recorder';
import {
  fetchMintingClaimByClaimId,
  type MintingClaimRow
} from '@/api/minting-claims/api.minting-claims.db';
import { BadRequestException } from '@/exceptions';
import {
  uploadMintingClaimToArweave,
  arweaveTxIdFromUrl
} from '@/minting-claims/claims-media-arweave-upload';
import { arweaveFileUploader } from '@/arweave';
import { ArweaveUploadDeadlineError } from '@/arweave/upload';
import * as priorityAlertsContext from '@/priority-alerts.context';
import {
  processMintingClaimUpload,
  handler,
  ClaimUploadRetryError
} from './index';
import {
  claimsMediaUploadLeaseDb,
  ClaimMediaUploadLeaseLostError
} from '@/minting-claims/claims-media-upload-lease.db';
import { restoreClaimUploadState } from '@/minting-claims/claims-media-upload-recovery';
import { sqs } from '@/sqs';
import { doInDbContext } from '@/secrets';
import type { Context, SQSEvent } from 'aws-lambda';

jest.mock('@/api/minting-claims/api.minting-claims.db', () => ({
  fetchMintingClaimByClaimId: jest.fn()
}));
jest.mock('@/minting-claims/claims-media-arweave-upload', () => ({
  arweaveTxIdFromUrl: jest.fn((url: string) => url.split('/').pop()),
  uploadMintingClaimToArweave: jest.fn()
}));
jest.mock('@/arweave', () => ({
  arweaveFileUploader: { uploadFileWithTransactionId: jest.fn() }
}));
jest.mock('@/priority-alerts.context', () => ({
  sendPriorityAlert: jest.fn()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (action: () => Promise<void>) => action())
}));
jest.mock('@/sqs', () => ({ sqs: { changeVisibility: jest.fn() } }));
jest.mock('@/minting-claims/claims-media-upload-lease.db', () => ({
  ...jest.requireActual('@/minting-claims/claims-media-upload-lease.db'),
  claimsMediaUploadLeaseDb: {
    acquire: jest.fn(),
    assertHeld: jest.fn(),
    release: jest.fn(),
    update: jest.fn(),
    loadState: jest.fn(),
    retryAfterSeconds: jest.fn()
  }
}));
const contract = '0x0000000000000000000000000000000000000001';
const lease = { contract, claimId: 1, token: 'test-owner' };
const result = {
  imageLocationUrl: 'https://arweave.net/image-tx',
  animationLocationUrl: null,
  metadataLocationUrl: 'https://arweave.net/metadata-tx'
};
const claim = { claim_id: 1, media_uploading: true } as MintingClaimRow;

describe('claims worker retry and ownership', () => {
  const fetchClaim = jest.mocked(fetchMintingClaimByClaimId);
  const upload = jest.mocked(uploadMintingClaimToArweave);
  const db = jest.mocked(claimsMediaUploadLeaseDb);
  const alert = jest.mocked(priorityAlertsContext.sendPriorityAlert);
  beforeEach(() => {
    jest.resetAllMocks();
    jest
      .mocked(arweaveTxIdFromUrl)
      .mockImplementation((url) => url.split('/').pop()!);
    jest.mocked(doInDbContext).mockImplementation(async (action) => action());
    fetchClaim.mockResolvedValue(claim);
    db.acquire.mockResolvedValue(lease);
    db.assertHeld.mockResolvedValue(undefined);
    db.loadState.mockResolvedValue(null);
    db.update.mockResolvedValue(undefined);
    db.release.mockResolvedValue(undefined);
    db.retryAfterSeconds.mockResolvedValue(301);
    upload.mockResolvedValue(result);
    alert.mockResolvedValue(undefined);
  });

  it('does no work when completed intent is redelivered', async () => {
    fetchClaim.mockResolvedValue({ ...claim, media_uploading: false });
    await processMintingClaimUpload(contract, 1, 10);
    expect(upload).not.toHaveBeenCalled();
    expect(db.acquire).not.toHaveBeenCalled();
  });

  it('does not publish if the primary reread finds inactive intent', async () => {
    fetchClaim
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({ ...claim, media_uploading: false });
    await processMintingClaimUpload(contract, 1, 1);
    expect(upload).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledWith(lease);
  });

  it('retains upload intent and requests short backoff after an early recoverable failure', async () => {
    upload.mockRejectedValue(new Error('fetch failed'));
    const failure = await processMintingClaimUpload(contract, 1, 1).catch(
      (error) => error
    );
    expect(failure).toBeInstanceOf(ClaimUploadRetryError);
    expect(failure.delaySeconds).toBeLessThanOrEqual(13);
    expect(db.update).not.toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ media_uploading: false })
    );
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        media_upload_state: expect.objectContaining({
          failures: 1,
          attemptActive: false
        })
      })
    );
    expect(alert).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledWith(lease);
  });

  it('does not treat the tenth SQS receive as the tenth upload failure', async () => {
    upload.mockRejectedValue(new Error('temporary failure'));
    await expect(
      processMintingClaimUpload(contract, 1, 10)
    ).rejects.toBeInstanceOf(ClaimUploadRetryError);
    expect(alert).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        media_upload_state: expect.objectContaining({ failures: 1 })
      })
    );
    expect(db.update).not.toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ media_uploading: false })
    );
  });

  it('records a permanent failure and clears publishing intent before alerting', async () => {
    upload.mockRejectedValue(new BadRequestException('invalid metadata'));
    await processMintingClaimUpload(contract, 1, 1);
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        media_uploading: false,
        media_upload_state: expect.objectContaining({ status: 'failed' })
      })
    );
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('clears intent after the durable failure budget is exhausted', async () => {
    const { claimUploadInputHash } = jest.requireActual(
      '@/minting-claims/claims-media-upload-recovery'
    );
    const state = restoreClaimUploadState(null, claimUploadInputHash(claim));
    state.failures = 9;
    db.loadState.mockResolvedValue(state);
    upload.mockRejectedValue(new Error('still unavailable'));
    await processMintingClaimUpload(contract, 1, 2);
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({ media_uploading: false })
    );
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('does not publish when the initial checkpoint write fails', async () => {
    db.update.mockRejectedValue(new Error('database unavailable'));
    await expect(processMintingClaimUpload(contract, 1, 1)).rejects.toThrow(
      'database unavailable'
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('does not overlap an active owner and defers until its database-clock expiry', async () => {
    db.acquire.mockResolvedValue(null);
    const error = await processMintingClaimUpload(contract, 1, 2).catch(
      (error) => error
    );
    expect(error.delaySeconds).toBe(301);
    expect(upload).not.toHaveBeenCalled();
    expect(db.release).not.toHaveBeenCalled();
  });

  it('never clears intent or commits completion after ownership is lost', async () => {
    db.assertHeld.mockRejectedValue(new ClaimMediaUploadLeaseLostError());
    upload.mockImplementation(async (_contract, _claim, callbacks) => {
      await callbacks!.beforePublish!();
      return result;
    });
    await expect(
      processMintingClaimUpload(contract, 1, 1)
    ).rejects.toBeInstanceOf(ClaimUploadRetryError);
    expect(db.update).not.toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ media_uploading: false })
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('checkpoints completed media before the final metadata receipt and clears recovery state atomically', async () => {
    upload.mockImplementation(async (_contract, _claim, callbacks) => {
      await callbacks!.onImageUploaded!('https://arweave.net/image-tx');
      await callbacks!.onAnimationUploaded!('https://arweave.net/video-tx');
      return {
        ...result,
        animationLocationUrl: 'https://arweave.net/video-tx'
      };
    });
    await processMintingClaimUpload(contract, 1, 1);
    const writes = db.update.mock.calls.map((call) => call[1]);
    expect(writes[1]).toEqual({ image_location: 'image-tx' });
    expect(writes[2]).toEqual({ animation_location: 'video-tx' });
    expect(writes[3]).toEqual({
      image_location: 'image-tx',
      animation_location: 'video-tx',
      metadata_location: 'metadata-tx',
      media_uploading: false,
      media_upload_state: null
    });
  });

  it('hands off progress within seconds without charging an upload failure', async () => {
    jest
      .mocked(arweaveFileUploader.uploadFileWithTransactionId)
      .mockImplementation(async (_bytes, _type, hooks) => {
        await hooks!.onState(
          {
            transaction: { id: 'a'.repeat(43) },
            data_base64: '',
            chunkIndex: 735,
            txPosted: true,
            lastRequestTimeEnd: 0,
            lastResponseStatus: 200,
            lastResponseError: ''
          },
          { signal: new AbortController().signal }
        );
        throw new ArweaveUploadDeadlineError('session deadline');
      });
    upload.mockImplementation(async (_contract, _claim, callbacks) => {
      await callbacks!.publishFile!(
        'animation',
        Buffer.from('video'),
        'video/mp4',
        'source'
      );
      return result;
    });
    const error = await processMintingClaimUpload(contract, 1, 20).catch(
      (error) => error
    );
    expect(error.delaySeconds).toBe(2);
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        media_upload_state: expect.objectContaining({
          failures: 0,
          progress: 735
        })
      })
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it('returns an unacknowledged message and changes its visibility for a controlled retry', async () => {
    upload.mockRejectedValue(new Error('network unavailable'));
    const event = {
      Records: [
        {
          messageId: 'message-1',
          body: JSON.stringify({ contract, claim_id: 1 }),
          attributes: { ApproximateReceiveCount: '1' },
          receiptHandle: 'receipt',
          eventSourceARN:
            'arn:aws:sqs:region:account:claims-media-arweave-upload'
        }
      ]
    } as unknown as SQSEvent;
    const response = await handler(
      event,
      { getRemainingTimeInMillis: () => 900000 } as Context,
      () => undefined
    );
    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-1' }]
    });
    expect(sqs.changeVisibility).toHaveBeenCalledWith({
      queueName: 'claims-media-arweave-upload',
      receiptHandle: 'receipt',
      timeoutSeconds: expect.any(Number)
    });
  });

  it('acknowledges malformed input once instead of repeatedly retrying it', async () => {
    const event = {
      Records: [
        {
          messageId: 'poison',
          body: 'not json',
          attributes: {},
          receiptHandle: 'receipt',
          eventSourceARN:
            'arn:aws:sqs:region:account:claims-media-arweave-upload'
        }
      ]
    } as unknown as SQSEvent;
    const response = await handler(
      event,
      { getRemainingTimeInMillis: () => 900000 } as Context,
      () => undefined
    );
    expect(response).toEqual({ batchItemFailures: [] });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('resumes accepted metadata after the final database commit fails', async () => {
    let durable: unknown = null;
    let failFinal = true;
    let signatures = 0;
    db.loadState.mockImplementation(async () => durable);
    db.update.mockImplementation(async (_lease, checkpoint) => {
      if (checkpoint.metadata_location && failFinal) {
        failFinal = false;
        throw new Error('final receipt commit failed');
      }
      if (checkpoint.media_upload_state !== undefined)
        durable = structuredClone(checkpoint.media_upload_state);
    });
    jest
      .mocked(arweaveFileUploader.uploadFileWithTransactionId)
      .mockImplementation(async (_bytes, _type, hooks) => {
        if (!hooks!.savedState) signatures++;
        else expect(hooks!.savedState.transaction.id).toBe('a'.repeat(43));
        await hooks!.onState(
          {
            transaction: { id: 'a'.repeat(43) },
            data_base64: '',
            chunkIndex: 1,
            txPosted: true,
            lastRequestTimeEnd: 0,
            lastResponseStatus: 200,
            lastResponseError: ''
          },
          { signal: new AbortController().signal }
        );
        return {
          url: 'https://arweave.net/' + 'a'.repeat(43),
          transaction_id: 'a'.repeat(43)
        };
      });
    upload.mockImplementation(async (_contract, _claim, callbacks) => {
      const metadata = await callbacks!.publishFile!(
        'metadata',
        Buffer.from('{"original":true}'),
        'application/json',
        'claim-metadata'
      );
      return { ...result, metadataLocationUrl: metadata.url };
    });
    await expect(processMintingClaimUpload(contract, 1, 1)).rejects.toThrow(
      'final receipt commit failed'
    );
    await processMintingClaimUpload(contract, 1, 2);
    expect(signatures).toBe(1);
    expect(durable).toBeNull();
    expect(db.update).toHaveBeenLastCalledWith(
      lease,
      expect.objectContaining({
        media_uploading: false,
        metadata_location: 'a'.repeat(43)
      })
    );
  });

  it('retries a mint-log capture failure without starting an upload', async () => {
    const write = jest
      .spyOn(mintLogRecorder, 'write')
      .mockRejectedValueOnce(new Error('mint log unavailable'));
    try {
      const response = await handler(
        {
          Records: [
            {
              messageId: 'log-failure',
              body: JSON.stringify({ contract, claim_id: 1 }),
              attributes: {},
              receiptHandle: 'receipt',
              eventSourceARN:
                'arn:aws:sqs:region:account:claims-media-arweave-upload'
            }
          ]
        } as unknown as SQSEvent,
        { getRemainingTimeInMillis: () => 900000 } as Context,
        () => undefined
      );
      expect(write).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'claim.media', lockScope: 'capture' }),
        expect.any(Function)
      );
      expect(response).toEqual({
        batchItemFailures: [{ itemIdentifier: 'log-failure' }]
      });
      expect(sqs.changeVisibility).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutSeconds: 30 })
      );
      expect(db.acquire).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('uses a short transport retry for failures before a recovery envelope can be loaded', async () => {
    fetchClaim.mockRejectedValueOnce(new Error('database read unavailable'));
    const event = {
      Records: [
        {
          messageId: 'early-failure',
          body: JSON.stringify({ contract, claim_id: 1 }),
          attributes: {},
          receiptHandle: 'receipt',
          eventSourceARN:
            'arn:aws:sqs:region:account:claims-media-arweave-upload'
        }
      ]
    } as unknown as SQSEvent;
    const response = await handler(
      event,
      { getRemainingTimeInMillis: () => 900000 } as Context,
      () => undefined
    );
    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: 'early-failure' }]
    });
    expect(sqs.changeVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 30 })
    );
    expect(db.acquire).not.toHaveBeenCalled();
  });
});
