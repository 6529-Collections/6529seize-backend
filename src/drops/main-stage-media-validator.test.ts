import { CLOUDFRONT_LINK } from '@/constants';
import { MAX_MAIN_STAGE_MEDIA_BYTES } from '@/minting-claims/media-limits';
import { validateMainStageMediaSize } from './main-stage-media-validator';

describe('validateMainStageMediaSize', () => {
  it('accepts a stored object at the 250 MiB boundary', async () => {
    const send = jest.fn().mockResolvedValue({
      ContentLength: MAX_MAIN_STAGE_MEDIA_BYTES
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

  it('rejects an object larger than 250 MiB', async () => {
    const send = jest.fn().mockResolvedValue({
      ContentLength: MAX_MAIN_STAGE_MEDIA_BYTES + 1
    });

    await expect(
      validateMainStageMediaSize(`${CLOUDFRONT_LINK}/drops/author/file.mp4`, {
        s3: { send },
        bucket: 'bucket'
      })
    ).rejects.toThrow('Main Stage media must not exceed 250 MiB');
  });

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
