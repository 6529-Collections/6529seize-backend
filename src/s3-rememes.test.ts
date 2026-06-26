const sendMock = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: sendMock
  })),
  ListObjectsV2Command: jest.fn((input) => ({
    commandName: 'ListObjectsV2Command',
    input
  })),
  PutObjectCommand: jest.fn((input) => ({
    commandName: 'PutObjectCommand',
    input
  }))
}));

jest.mock('./db', () => ({
  persistRememes: jest.fn()
}));

jest.mock('@/media/image-resize', () => ({
  resizeImageBufferToHeight: jest.fn()
}));

jest.mock('@/arweave-gateway-fallback', () => ({
  withArweaveFallback: jest.fn()
}));

jest.mock('./media-checker', () => ({
  mediaChecker: {
    getContentType: jest.fn()
  }
}));

jest.mock('./ipfs', () => ({
  ipfs: {
    ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined: jest.fn(
      (url?: string) => url ?? ''
    )
  }
}));

import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { CLOUDFRONT_LINK } from '@/constants';
import { resizeImageBufferToHeight } from '@/media/image-resize';
import { persistRememes } from './db';
import {
  Rememe,
  RememeS3ProcessingStatus,
  RememeSource
} from './entities/IRememe';
import { mediaChecker } from './media-checker';
import { persistRememesS3 } from './s3_rememes';

const BASE_KEY = '0xabc-1.';

describe('persistRememesS3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_6529_IMAGES_BUCKET_NAME = 'test-bucket';
  });

  it('persists existing legacy S3 assets without probing or uploading', async () => {
    mockS3Objects({
      [`rememes/images/original/${BASE_KEY}`]: [
        `rememes/images/original/${BASE_KEY}png`
      ],
      [`rememes/images/scaled/${BASE_KEY}`]: [
        `rememes/images/scaled/${BASE_KEY}png`
      ],
      [`rememes/images/thumbnail/${BASE_KEY}`]: [
        `rememes/images/thumbnail/${BASE_KEY}png`
      ],
      [`rememes/images/icon/${BASE_KEY}`]: [
        `rememes/images/icon/${BASE_KEY}png`
      ]
    });

    await persistRememesS3([buildRememe()]);

    expect(mediaChecker.getContentType).not.toHaveBeenCalled();
    expect(withArweaveFallback).not.toHaveBeenCalled();
    expect(resizeImageBufferToHeight).not.toHaveBeenCalled();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(ListObjectsV2Command).toHaveBeenCalledTimes(4);
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: `${CLOUDFRONT_LINK}/rememes/images/original/${BASE_KEY}png`,
        s3_image_scaled: `${CLOUDFRONT_LINK}/rememes/images/scaled/${BASE_KEY}png`,
        s3_image_thumbnail: `${CLOUDFRONT_LINK}/rememes/images/thumbnail/${BASE_KEY}png`,
        s3_image_icon: `${CLOUDFRONT_LINK}/rememes/images/icon/${BASE_KEY}png`,
        s3_image_processing_status: RememeS3ProcessingStatus.COMPLETE,
        s3_image_processing_attempts: 0
      })
    ]);
  });

  it('persists unsupported video originals without trying to resize them', async () => {
    mockS3Objects({
      [`rememes/images/original/${BASE_KEY}`]: [
        `rememes/images/original/${BASE_KEY}mp4`
      ]
    });

    await persistRememesS3([buildRememe()]);

    expect(mediaChecker.getContentType).not.toHaveBeenCalled();
    expect(withArweaveFallback).not.toHaveBeenCalled();
    expect(resizeImageBufferToHeight).not.toHaveBeenCalled();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: `${CLOUDFRONT_LINK}/rememes/images/original/${BASE_KEY}mp4`,
        s3_image_scaled: null,
        s3_image_thumbnail: null,
        s3_image_icon: null,
        s3_image_processing_status: RememeS3ProcessingStatus.UNSUPPORTED,
        s3_image_processing_attempts: 1,
        s3_image_processing_error: 'Unsupported rememe media format: mp4'
      })
    ]);
  });

  it('marks repeatedly unresolved media as a permanent error', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue(null);

    await persistRememesS3([
      buildRememe({
        s3_image_processing_attempts: 2
      })
    ]);

    expect(withArweaveFallback).not.toHaveBeenCalled();
    expect(resizeImageBufferToHeight).not.toHaveBeenCalled();
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: null,
        s3_image_scaled: null,
        s3_image_thumbnail: null,
        s3_image_icon: null,
        s3_image_processing_status: RememeS3ProcessingStatus.PERMANENT_ERROR,
        s3_image_processing_attempts: 3,
        s3_image_processing_error: 'Could not resolve rememe media format'
      })
    ]);
  });
});

function buildRememe(overrides: Partial<Rememe> = {}): Rememe {
  return {
    contract: '0xabc',
    id: '1',
    deployer: '0xdeployer',
    token_uri: 'https://example.test/token',
    token_type: 'ERC721',
    image: 'https://example.test/rememe.png',
    animation: '',
    meme_references: [1],
    metadata: {},
    contract_opensea_data: {},
    media: {
      gateway: 'https://example.test/rememe.png'
    },
    s3_image_original: null,
    s3_image_scaled: null,
    s3_image_thumbnail: null,
    s3_image_icon: null,
    s3_image_processing_attempts: 0,
    source: RememeSource.FILE,
    ...overrides
  };
}

function mockS3Objects(objectsByPrefix: Record<string, string[]>) {
  sendMock.mockImplementation(async (command) => {
    if (command.commandName === 'ListObjectsV2Command') {
      return {
        Contents: (objectsByPrefix[command.input.Prefix] ?? []).map((Key) => ({
          Key
        }))
      };
    }

    return {
      $metadata: {
        httpStatusCode: 200
      }
    };
  });
}
