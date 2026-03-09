import { MEMES_CONTRACT } from '@/constants';
import {
  publishMissingS3UploaderAuditJobs,
  resolveAuditS3CheckConcurrency,
  selectAuditJobsToEnqueueForNft
} from '@/nftsLoop/s3-uploader-audit';
import {
  QueueableNft,
  S3UploaderCollectionType,
  S3UploaderJobType
} from '@/s3Uploader/s3-uploader.jobs';
import { sqs } from '@/sqs';

jest.mock('@/sqs', () => ({
  sqs: {
    sendToQueueName: jest.fn()
  }
}));

describe('s3 uploader audit precheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not enqueue image job when all requested image variants already exist', async () => {
    const nft: QueueableNft = {
      contract: MEMES_CONTRACT,
      id: 1,
      scaled: 'x',
      thumbnail: 'x',
      icon: 'x',
      metadata: {
        image: 'https://arweave.net/tx-image',
        image_details: { format: 'WEBP' }
      }
    };

    const s3ObjectExistsFn = jest
      .fn()
      .mockResolvedValue({ exists: true, invalidate: false });

    const result = await selectAuditJobsToEnqueueForNft({
      nft,
      collectionType: S3UploaderCollectionType.NFT,
      bucket: 'bucket',
      s3ObjectExistsFn
    });

    expect(result.totalJobs).toBe(1);
    expect(result.jobsToEnqueue).toEqual([]);
    expect(s3ObjectExistsFn).toHaveBeenCalledTimes(4);
  });

  it('enqueues image job when one image variant is missing', async () => {
    const nft: QueueableNft = {
      contract: MEMES_CONTRACT,
      id: 2,
      scaled: 'x',
      metadata: {
        image: 'https://arweave.net/tx-image-2',
        image_details: { format: 'WEBP' }
      }
    };

    const s3ObjectExistsFn = jest
      .fn()
      .mockResolvedValueOnce({ exists: true, invalidate: false })
      .mockResolvedValueOnce({ exists: false, invalidate: false });

    const result = await selectAuditJobsToEnqueueForNft({
      nft,
      collectionType: S3UploaderCollectionType.NFT,
      bucket: 'bucket',
      s3ObjectExistsFn
    });

    expect(result.totalJobs).toBe(1);
    expect(result.jobsToEnqueue).toHaveLength(1);
    expect(result.jobsToEnqueue[0].jobType).toBe(S3UploaderJobType.IMAGE);
    expect(s3ObjectExistsFn).toHaveBeenCalledTimes(2);
  });

  it('enqueues video job when scaled variant is missing', async () => {
    const nft: QueueableNft = {
      contract: MEMES_CONTRACT,
      id: 3,
      metadata: {
        animation: 'https://arweave.net/tx-video',
        animation_details: { format: 'MP4' }
      }
    };

    const s3ObjectExistsFn = jest
      .fn()
      .mockResolvedValueOnce({ exists: true, invalidate: false })
      .mockResolvedValueOnce({ exists: false, invalidate: false });

    const result = await selectAuditJobsToEnqueueForNft({
      nft,
      collectionType: S3UploaderCollectionType.NFT,
      bucket: 'bucket',
      s3ObjectExistsFn
    });

    expect(result.totalJobs).toBe(1);
    expect(result.jobsToEnqueue).toHaveLength(1);
    expect(result.jobsToEnqueue[0].jobType).toBe(S3UploaderJobType.VIDEO);
    expect(s3ObjectExistsFn).toHaveBeenCalledTimes(2);
  });

  it('publishes only jobs selected by precheck', async () => {
    const missing: QueueableNft = {
      contract: MEMES_CONTRACT,
      id: 4,
      metadata: {
        animation: 'https://arweave.net/tx-video-4',
        animation_details: { format: 'MP4' }
      }
    };
    const existing: QueueableNft = {
      contract: MEMES_CONTRACT,
      id: 5,
      metadata: {
        animation: 'https://arweave.net/tx-video-5',
        animation_details: { format: 'MP4' }
      }
    };

    const s3ObjectExistsFn = jest
      .fn()
      .mockResolvedValueOnce({ exists: true, invalidate: false })
      .mockResolvedValueOnce({ exists: false, invalidate: false })
      .mockResolvedValueOnce({ exists: true, invalidate: false })
      .mockResolvedValueOnce({ exists: true, invalidate: false });

    (sqs.sendToQueueName as jest.Mock).mockResolvedValue(undefined);
    await publishMissingS3UploaderAuditJobs({
      nfts: [missing, existing],
      collectionType: S3UploaderCollectionType.NFT,
      bucket: 'bucket',
      concurrency: 2,
      s3ObjectExistsFn
    });

    expect(sqs.sendToQueueName).toHaveBeenCalledTimes(1);
  });

  it('uses safe default audit concurrency and clamps configured value', () => {
    expect(resolveAuditS3CheckConcurrency(null)).toBe(25);
    expect(resolveAuditS3CheckConcurrency(0)).toBe(1);
    expect(resolveAuditS3CheckConcurrency(7)).toBe(7);
    expect(resolveAuditS3CheckConcurrency(99)).toBe(50);
  });
});
