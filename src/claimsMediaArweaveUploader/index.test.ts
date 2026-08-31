import {
  fetchMintingClaimByClaimId,
  updateMintingClaim
} from '@/api/minting-claims/api.minting-claims.db';
import { BadRequestException } from '@/exceptions';
import { uploadMintingClaimToArweave } from '@/minting-claims/claims-media-arweave-upload';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { processMintingClaimUpload } from './index';

jest.mock('@/api/minting-claims/api.minting-claims.db', () => ({
  fetchMintingClaimByClaimId: jest.fn(),
  updateMintingClaim: jest.fn()
}));
jest.mock('@/minting-claims/claims-media-arweave-upload', () => ({
  arweaveTxIdFromUrl: jest.fn((url: string) => url.split('/').pop()),
  uploadMintingClaimToArweave: jest.fn()
}));
jest.mock('@/priority-alerts.context', () => ({
  sendPriorityAlert: jest.fn()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));

const CONTRACT = '0x0000000000000000000000000000000000000001';

describe('processMintingClaimUpload', () => {
  const fetchClaimMock = jest.mocked(fetchMintingClaimByClaimId);
  const updateClaimMock = jest.mocked(updateMintingClaim);
  const uploadMock = jest.mocked(uploadMintingClaimToArweave);
  const alertMock = jest.mocked(priorityAlertsContext.sendPriorityAlert);

  beforeEach(() => {
    jest.clearAllMocks();
    fetchClaimMock.mockResolvedValue({
      claim_id: 1,
      media_uploading: true
    } as any);
    updateClaimMock.mockResolvedValue(undefined);
    alertMock.mockResolvedValue(undefined);
  });

  it('keeps the upload lock set for retryable failures before the final attempt', async () => {
    uploadMock.mockRejectedValue(new Error('temporary gateway failure'));

    await expect(processMintingClaimUpload(CONTRACT, 1, 2)).rejects.toThrow(
      'temporary gateway failure'
    );

    expect(updateClaimMock).not.toHaveBeenCalledWith(CONTRACT, 1, {
      media_uploading: false
    });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('does not page on the first retryable failure', async () => {
    uploadMock.mockRejectedValue(new Error('temporary gateway failure'));

    await expect(processMintingClaimUpload(CONTRACT, 1, 1)).rejects.toThrow(
      'temporary gateway failure'
    );

    expect(updateClaimMock).not.toHaveBeenCalledWith(CONTRACT, 1, {
      media_uploading: false
    });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('clears the upload lock when the final retry fails', async () => {
    uploadMock.mockRejectedValue(new Error('persistent gateway failure'));

    await expect(processMintingClaimUpload(CONTRACT, 1, 10)).rejects.toThrow(
      'persistent gateway failure'
    );

    expect(updateClaimMock).toHaveBeenCalledWith(CONTRACT, 1, {
      media_uploading: false
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('treats invalid claim metadata as a terminal failure', async () => {
    uploadMock.mockRejectedValue(new BadRequestException('invalid metadata'));

    await expect(
      processMintingClaimUpload(CONTRACT, 1, 1)
    ).resolves.toBeUndefined();

    expect(updateClaimMock).toHaveBeenCalledWith(CONTRACT, 1, {
      media_uploading: false
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('still clears terminal state when the priority alert fails', async () => {
    uploadMock.mockRejectedValue(new BadRequestException('invalid metadata'));
    alertMock.mockRejectedValue(new Error('alert unavailable'));

    await expect(
      processMintingClaimUpload(CONTRACT, 1, 1)
    ).resolves.toBeUndefined();

    expect(updateClaimMock).toHaveBeenCalledWith(CONTRACT, 1, {
      media_uploading: false
    });
  });

  it('retries when a terminal failure cannot clear the upload lock', async () => {
    uploadMock.mockRejectedValue(new BadRequestException('invalid metadata'));
    updateClaimMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(processMintingClaimUpload(CONTRACT, 1, 1)).rejects.toThrow(
      'database unavailable'
    );

    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('checkpoints media locations before saving the metadata location', async () => {
    uploadMock.mockImplementation(async (_contract, _claim, callbacks) => {
      await callbacks?.onImageUploaded?.('https://arweave.net/image-tx');
      await callbacks?.onAnimationUploaded?.(
        'https://arweave.net/animation-tx'
      );
      return {
        imageLocationUrl: 'https://arweave.net/image-tx',
        animationLocationUrl: 'https://arweave.net/animation-tx',
        metadataLocationUrl: 'https://arweave.net/metadata-tx'
      };
    });

    await processMintingClaimUpload(CONTRACT, 1, 1);

    expect(updateClaimMock.mock.calls).toEqual([
      [CONTRACT, 1, { media_uploading: true }],
      [CONTRACT, 1, { image_location: 'image-tx' }],
      [CONTRACT, 1, { animation_location: 'animation-tx' }],
      [
        CONTRACT,
        1,
        {
          image_location: 'image-tx',
          animation_location: 'animation-tx',
          metadata_location: 'metadata-tx',
          media_uploading: false
        }
      ]
    ]);
  });
});
