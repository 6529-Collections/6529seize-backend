import { CLOUDFRONT_LINK } from '@/constants';
import {
  MAX_MAIN_STAGE_MEDIA_BYTES,
  MAX_MINTING_CLAIM_MEDIA_BYTES
} from '@/minting-claims/media-limits';
import { validateMainStageMediaSize } from './main-stage-media-validator';

describe('validateMainStageMediaSize', () => {
  it('uses the same exact 250 MB ceiling for submissions and minting', () => {
    expect(MAX_MAIN_STAGE_MEDIA_BYTES).toBe(250_000_000);
    expect(MAX_MINTING_CLAIM_MEDIA_BYTES).toBe(250_000_000);
  });

  it('accepts a stored object at the 250 MB boundary', async () => {
    const send = jest.fn().mockResolvedValue({
      ContentLength: 250_000_000
    });

    await expect(
      validateMainStageMediaSize(`${CLOUDFRONT_LINK}/drops/author/file.glb`, {
        s3: { send },
        bucket: 'bucket'
      })
    ).resolves.toBeUndefined();

    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'bucket',
      Key: 'drops/author/file.glb'
    });
  });

  it.each([250_000_001, 262_144_000])(
    'rejects an object of %i bytes',
    async (bytes) => {
      const send = jest.fn().mockResolvedValue({
        ContentLength: bytes
      });

      await expect(
        validateMainStageMediaSize(`${CLOUDFRONT_LINK}/drops/author/file.mp4`, {
          s3: { send },
          bucket: 'bucket'
        })
      ).rejects.toThrow('Main Stage media must not exceed 250 MB');
    }
  );

  it('fails closed when the stored object cannot be inspected', async () => {
    const send = jest.fn().mockRejectedValue(new Error('NotFound'));

    await expect(
      validateMainStageMediaSize(`${CLOUDFRONT_LINK}/drops/author/file.mp4`, {
        s3: { send },
        bucket: 'bucket'
      })
    ).rejects.toThrow('Main Stage media could not be verified');
  });

  it('does not inspect decentralized HTML media', async () => {
    const send = jest.fn();

    await expect(
      validateMainStageMediaSize('ipfs://bafy/example.html', {
        s3: { send },
        bucket: 'bucket'
      })
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
