import {
  fetchMintingClaimByClaimId,
  updateMintingClaim
} from '@/api/minting-claims/api.minting-claims.db';
import { BadRequestException } from '@/exceptions';
import { uploadMintingClaimToArweave } from '@/minting-claims/claims-media-arweave-upload';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { processMintingClaimUpload } from './index';
import { DbPoolName } from '@/db-query.options';
import {
  claimsMediaUploadLeaseDb,
  ClaimMediaUploadLeaseLostError,
  type ClaimMediaUploadLease
} from '@/minting-claims/claims-media-upload-lease.db';

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
jest.mock('@/minting-claims/claims-media-upload-lease.db', () => ({
  ...jest.requireActual('@/minting-claims/claims-media-upload-lease.db'),
  claimsMediaUploadLeaseDb: {
    acquire: jest.fn(),
    assertHeld: jest.fn(),
    release: jest.fn(),
    update: jest.fn((lease: ClaimMediaUploadLease, changes: unknown) =>
      jest
        .requireMock('@/api/minting-claims/api.minting-claims.db')
        .updateMintingClaim(lease.contract, lease.claimId, changes)
    )
  }
}));

const CONTRACT = '0x0000000000000000000000000000000000000001';

describe('processMintingClaimUpload', () => {
  const fetchClaimMock = jest.mocked(fetchMintingClaimByClaimId);
  const updateClaimMock = jest.mocked(updateMintingClaim);
  const uploadMock = jest.mocked(uploadMintingClaimToArweave);
  const alertMock = jest.mocked(priorityAlertsContext.sendPriorityAlert);
  const leaseDb = jest.mocked(claimsMediaUploadLeaseDb);
  const lease = { contract: CONTRACT, claimId: 1, token: 'test-owner' };

  beforeEach(() => {
    jest.clearAllMocks();
    fetchClaimMock.mockResolvedValue({
      claim_id: 1,
      media_uploading: true
    } as any);
    updateClaimMock.mockResolvedValue(undefined);
    alertMock.mockResolvedValue(undefined);
    leaseDb.acquire.mockResolvedValue(lease);
    leaseDb.assertHeld.mockResolvedValue(undefined);
    leaseDb.release.mockResolvedValue(undefined);
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

  it('does not publish again when a completed claim is redelivered', async () => {
    fetchClaimMock.mockResolvedValue({
      claim_id: 1,
      media_uploading: false
    } as NonNullable<Awaited<ReturnType<typeof fetchMintingClaimByClaimId>>>);

    await expect(
      processMintingClaimUpload(CONTRACT, 1, 2)
    ).resolves.toBeUndefined();

    expect(uploadMock).not.toHaveBeenCalled();
    expect(updateClaimMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('does not publish if the initial database update fails', async () => {
    const failure = new Error('database unavailable before upload');
    updateClaimMock.mockRejectedValueOnce(failure);

    await expect(processMintingClaimUpload(CONTRACT, 1, 1)).rejects.toBe(
      failure
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it.each(['existing-metadata-tx', ''])(
    'preserves active upload intent even with legacy metadata %j',
    async (metadataLocation) => {
      fetchClaimMock.mockResolvedValue({
        claim_id: 1,
        media_uploading: true,
        metadata_location: metadataLocation
      } as any);
      uploadMock.mockResolvedValue({
        imageLocationUrl: 'https://arweave.net/image-tx',
        animationLocationUrl: null,
        metadataLocationUrl: 'https://arweave.net/new-metadata-tx'
      });
      await expect(
        processMintingClaimUpload(CONTRACT, 1, 1)
      ).resolves.toBeUndefined();
      expect(uploadMock).toHaveBeenCalledTimes(1);
      expect(updateClaimMock).toHaveBeenCalledWith(
        CONTRACT,
        1,
        expect.objectContaining({
          metadata_location: 'new-metadata-tx',
          media_uploading: false
        })
      );
    }
  );

  it('releases ownership without publishing if the primary reread finds inactive intent', async () => {
    fetchClaimMock
      .mockResolvedValueOnce({ claim_id: 1, media_uploading: true } as any)
      .mockResolvedValueOnce({
        claim_id: 1,
        media_uploading: false,
        metadata_location: 'completed-tx'
      } as any);
    await expect(
      processMintingClaimUpload(CONTRACT, 1, 2)
    ).resolves.toBeUndefined();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(updateClaimMock).not.toHaveBeenCalled();
    expect(leaseDb.release).toHaveBeenCalledWith(lease);
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

  it('rejects an overlapping delivery without starting a second publisher', async () => {
    leaseDb.acquire.mockResolvedValueOnce(lease).mockResolvedValueOnce(null);
    let releaseUpload: () => void = () => undefined;
    const pendingUpload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    uploadMock.mockImplementation(async () => {
      await pendingUpload;
      return {
        imageLocationUrl: 'https://arweave.net/image-tx',
        animationLocationUrl: null,
        metadataLocationUrl: 'https://arweave.net/metadata-tx'
      };
    });
    const first = processMintingClaimUpload(CONTRACT, 1, 1);
    const second = processMintingClaimUpload(CONTRACT, 1, 2);
    await expect(second).rejects.toThrow('already owned');
    releaseUpload();
    await first;
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(leaseDb.release).toHaveBeenCalledTimes(1);
    expect(fetchClaimMock).toHaveBeenCalledWith(CONTRACT, 1, {
      forcePool: DbPoolName.WRITE
    });
  });

  it('releases a failed attempt so redelivery can resume', async () => {
    uploadMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        imageLocationUrl: 'https://arweave.net/image-tx',
        animationLocationUrl: null,
        metadataLocationUrl: 'https://arweave.net/metadata-tx'
      });
    await expect(processMintingClaimUpload(CONTRACT, 1, 1)).rejects.toThrow(
      'temporary failure'
    );
    await expect(
      processMintingClaimUpload(CONTRACT, 1, 2)
    ).resolves.toBeUndefined();
    expect(leaseDb.acquire).toHaveBeenCalledTimes(2);
    expect(leaseDb.release).toHaveBeenNthCalledWith(1, lease);
    expect(leaseDb.release).toHaveBeenNthCalledWith(2, lease);
  });

  it('does not clear upload intent or save a final receipt after ownership is lost', async () => {
    leaseDb.assertHeld.mockRejectedValue(new ClaimMediaUploadLeaseLostError());
    uploadMock.mockImplementation(async (_contract, _claim, callbacks) => {
      await callbacks?.beforePublish?.();
      throw new Error('must not publish');
    });
    await expect(
      processMintingClaimUpload(CONTRACT, 1, 10)
    ).rejects.toBeInstanceOf(ClaimMediaUploadLeaseLostError);
    expect(updateClaimMock.mock.calls).toEqual([
      [CONTRACT, 1, { media_uploading: true }]
    ]);
    expect(alertMock).not.toHaveBeenCalled();
    expect(leaseDb.release).toHaveBeenCalledWith(lease);
  });

  it.each([Number.NaN, 0, 5000, 1200000])(
    'rejects an unsafe remaining runtime before acquisition (%s)',
    async (remaining) => {
      await expect(
        processMintingClaimUpload(CONTRACT, 1, 1, () => remaining)
      ).rejects.toThrow('lease safety bound');
      expect(leaseDb.acquire).not.toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();
    }
  );
});
