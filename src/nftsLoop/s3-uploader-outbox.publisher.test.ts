import { getDataSource } from '@/db';
import { S3UploaderOutboxStatus } from '@/entities/IS3UploaderOutbox';
import { publishPendingS3UploaderOutboxJobs } from '@/nftsLoop/s3-uploader-outbox.publisher';
import { isS3UploaderEnabledForEnvironment } from '@/s3Uploader/s3-uploader.queue';
import { sqs } from '@/sqs';

jest.mock('@/db', () => ({
  getDataSource: jest.fn()
}));

jest.mock('@/sqs', () => ({
  sqs: {
    sendToQueueName: jest.fn()
  }
}));

jest.mock('@/s3Uploader/s3-uploader.queue', () => ({
  isS3UploaderEnabledForEnvironment: jest.fn()
}));

type MockRepo = {
  count: jest.Mock;
  findOne: jest.Mock;
  createQueryBuilder: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
};

function makeOutboxRow(id: number) {
  return {
    id,
    attempts: 0,
    status: S3UploaderOutboxStatus.PENDING,
    created_at: 1,
    published_at: null,
    last_error: null,
    job: {
      reason: 'discover',
      collectionType: 'nft',
      contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
      tokenId: id,
      jobType: 'image',
      variants: ['original']
    }
  };
}

describe('publishPendingS3UploaderOutboxJobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isS3UploaderEnabledForEnvironment as jest.Mock).mockReturnValue(true);
  });

  it('continues to later pending ids even when an earlier batch entirely fails', async () => {
    const repo: MockRepo = {
      count: jest.fn().mockResolvedValue(3),
      findOne: jest.fn().mockResolvedValue({ id: 3 }),
      createQueryBuilder: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 0 })
    };

    const batches = [
      [makeOutboxRow(1), makeOutboxRow(2)],
      [makeOutboxRow(3)],
      []
    ];
    const queryBuilderInstances: Array<{ andWhere: jest.Mock }> = [];
    repo.createQueryBuilder.mockImplementation(() => {
      const queryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(batches.shift() ?? [])
      };
      queryBuilderInstances.push(queryBuilder);
      return queryBuilder;
    });

    (getDataSource as jest.Mock).mockReturnValue({
      getRepository: jest.fn().mockReturnValue(repo)
    });

    (sqs.sendToQueueName as jest.Mock).mockImplementation(({ message }) => {
      if (message.tokenId === 3) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error('queue unavailable'));
    });

    await publishPendingS3UploaderOutboxJobs();

    expect(sqs.sendToQueueName).toHaveBeenCalledTimes(3);
    expect(sqs.sendToQueueName).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ tokenId: 3 })
      })
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 3 },
      expect.objectContaining({
        status: S3UploaderOutboxStatus.PUBLISHED
      })
    );
    expect(queryBuilderInstances[0].andWhere).toHaveBeenCalledWith(
      'outbox.id > :lastProcessedId',
      { lastProcessedId: 0 }
    );
    expect(queryBuilderInstances[1].andWhere).toHaveBeenCalledWith(
      'outbox.id > :lastProcessedId',
      { lastProcessedId: 2 }
    );
  });

  it('runs retention cleanup even when there are no pending rows', async () => {
    const repo: MockRepo = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 2 })
    };

    (getDataSource as jest.Mock).mockReturnValue({
      getRepository: jest.fn().mockReturnValue(repo)
    });

    await publishPendingS3UploaderOutboxJobs();

    expect(repo.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: S3UploaderOutboxStatus.PUBLISHED
      })
    );
  });
});
