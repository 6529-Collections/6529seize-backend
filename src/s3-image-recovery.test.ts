const sendMock = jest.fn();
const downloadMock = jest.fn();
const resizeMock = jest.fn();
const invalidateMock = jest.fn();

jest.mock('@/s3.client', () => ({ getS3: () => ({ send: sendMock }) }));
jest.mock('@/media/image-download', () => ({
  downloadImageBuffer: downloadMock
}));
jest.mock('@/media/image-resize', () => ({
  resizeImageBufferToHeight: resizeMock
}));
jest.mock('./cloudfront', () => ({ invalidateCloudFront: invalidateMock }));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
  }
}));

import { NFT } from '@/entities/INFT';
import { MEMES_CONTRACT } from '@/constants';
import { processS3UploaderJob } from './s3';
import {
  S3UploaderCollectionType,
  S3UploaderImageVariant,
  S3UploaderJobType
} from '@/s3Uploader/s3-uploader.jobs';

const originalKey = `images/original/${MEMES_CONTRACT}/558.JPG`;
const nft = {
  contract: MEMES_CONTRACT,
  id: 558,
  scaled: 'scaled',
  thumbnail: 'thumbnail',
  icon: 'icon',
  metadata: {
    image: `https://arweave.net/${'A'.repeat(43)}`,
    image_details: { format: 'JPG' }
  }
} as NFT;
const job = {
  collectionType: S3UploaderCollectionType.NFT,
  contract: MEMES_CONTRACT,
  tokenId: 558,
  reason: 'discover' as const,
  jobType: S3UploaderJobType.IMAGE as const,
  variants: [
    S3UploaderImageVariant.ORIGINAL,
    S3UploaderImageVariant.SCALED_1000,
    S3UploaderImageVariant.SCALED_450,
    S3UploaderImageVariant.SCALED_60
  ]
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AWS_6529_IMAGES_BUCKET_NAME = 'test-bucket';
  sendMock.mockImplementation(async (command) => {
    if (command.constructor.name === 'HeadObjectCommand')
      throw new Error('Not found');
    return { ETag: 'uploaded' };
  });
  resizeMock.mockResolvedValue(Buffer.from('resized-image'));
});

it('replaces a zero-byte original and creates all variants using one validated download', async () => {
  sendMock.mockImplementation(async (command) => {
    if (command.constructor.name === 'HeadObjectCommand') {
      if (command.input.Key === originalKey) {
        return { ContentLength: 0, Metadata: { 'tx-id': 'A'.repeat(43) } };
      }
      throw new Error('Not found');
    }
    return { ETag: 'uploaded' };
  });
  downloadMock.mockResolvedValue(Buffer.from('validated-image'));
  await processS3UploaderJob(nft, job);

  const uploads = sendMock.mock.calls
    .map(([command]) => command)
    .filter((command) => command.constructor.name === 'PutObjectCommand');
  expect(uploads).toHaveLength(4);
  expect(uploads[0].input).toMatchObject({
    Key: originalKey,
    Body: Buffer.from('validated-image')
  });
  expect(downloadMock).toHaveBeenCalledTimes(1);
  expect(resizeMock).toHaveBeenCalledTimes(3);
});

it('fails the job without uploading any object when all source gateways fail', async () => {
  const unavailable = new Error('No gateway returned a valid image');
  downloadMock.mockRejectedValue(unavailable);
  await expect(processS3UploaderJob(nft, job)).rejects.toBe(unavailable);
  expect(
    sendMock.mock.calls.some(
      ([command]) => command.constructor.name === 'PutObjectCommand'
    )
  ).toBe(false);
  expect(resizeMock).not.toHaveBeenCalled();
});

it('throws instead of silently succeeding when image processing produces no bytes', async () => {
  downloadMock.mockResolvedValue(Buffer.from('validated-image'));
  resizeMock.mockResolvedValue(Buffer.alloc(0));
  await expect(processS3UploaderJob(nft, job)).rejects.toThrow(
    'Image output buffer is empty'
  );
  const uploads = sendMock.mock.calls
    .map(([command]) => command)
    .filter((command) => command.constructor.name === 'PutObjectCommand');
  expect(uploads.every((command) => command.input.Body.length > 0)).toBe(true);
});
