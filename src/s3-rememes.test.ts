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

jest.mock('@/http/public-fetch', () => ({
  ...jest.requireActual('@/http/public-fetch'),
  publicFetch: jest.fn()
}));

jest.mock('@/media/raster-image-format', () => ({
  detectRasterImageFormat: jest.fn()
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
import { publicFetch, PublicResponseTooLargeError } from '@/http/public-fetch';
import { detectRasterImageFormat } from '@/media/raster-image-format';

const BASE_KEY = '0xabc-1.';

describe('persistRememesS3', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_6529_IMAGES_BUCKET_NAME = 'test-bucket';
    jest
      .mocked(withArweaveFallback)
      .mockImplementation((url, fetchFn) => fetchFn(url));
    jest.mocked(detectRasterImageFormat).mockResolvedValue('png');
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

  it('persists unsupported video originals without trying to resize them or incrementing attempts', async () => {
    mockS3Objects({
      [`rememes/images/original/${BASE_KEY}`]: [
        `rememes/images/original/${BASE_KEY}mp4`
      ]
    });

    await persistRememesS3([
      buildRememe({
        s3_image_processing_attempts: 2
      })
    ]);

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
        s3_image_processing_attempts: 2,
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

  it('normalizes MIME content types and stores allow-listed S3 content types', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('image/png');
    jest.mocked(publicFetch).mockResolvedValue(
      buildFetchResponse({
        body: Buffer.from('image-bytes'),
        contentType: 'text/html'
      })
    );
    jest
      .mocked(resizeImageBufferToHeight)
      .mockResolvedValue(Buffer.from('resized-image'));

    await persistRememesS3([
      buildRememe({
        media: {
          gateway: 'https://gateway.example.test/different-rememe.png'
        }
      })
    ]);

    expect(mediaChecker.getContentType).toHaveBeenCalledWith(
      'https://example.test/rememe.png'
    );
    expect(withArweaveFallback).toHaveBeenCalledWith(
      'https://example.test/rememe.png',
      expect.any(Function)
    );
    expect(PutObjectCommand).toHaveBeenCalledTimes(4);
    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Key: `rememes/images/original/${BASE_KEY}png`,
        ContentType: 'image/png'
      })
    );
    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Key: `rememes/images/scaled/${BASE_KEY}webp`,
        ContentType: 'image/webp'
      })
    );
    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Key: `rememes/images/thumbnail/${BASE_KEY}webp`,
        ContentType: 'image/webp'
      })
    );
    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        Key: `rememes/images/icon/${BASE_KEY}webp`,
        ContentType: 'image/webp'
      })
    );
    // Rememe keys are only created when missing, so their bytes never change.
    expect(
      jest
        .mocked(PutObjectCommand)
        .mock.calls.map(([input]) => input.CacheControl)
    ).toEqual(Array(4).fill('public, max-age=31536000, immutable'));
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: `${CLOUDFRONT_LINK}/rememes/images/original/${BASE_KEY}png`,
        s3_image_scaled: `${CLOUDFRONT_LINK}/rememes/images/scaled/${BASE_KEY}webp`,
        s3_image_thumbnail: `${CLOUDFRONT_LINK}/rememes/images/thumbnail/${BASE_KEY}webp`,
        s3_image_icon: `${CLOUDFRONT_LINK}/rememes/images/icon/${BASE_KEY}webp`,
        s3_image_processing_status: RememeS3ProcessingStatus.COMPLETE
      })
    ]);
  });

  it('falls back to the media gateway when metadata image is not fetchable', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('image/png');
    jest.mocked(publicFetch).mockResolvedValue(
      buildFetchResponse({
        body: Buffer.from('image-bytes'),
        contentType: 'image/png'
      })
    );
    jest
      .mocked(resizeImageBufferToHeight)
      .mockResolvedValue(Buffer.from('resized-image'));

    await persistRememesS3([
      buildRememe({
        image: 'ar://raw-rememe-image',
        media: {
          gateway: 'https://gateway.example.test/rememe.png'
        }
      })
    ]);

    expect(mediaChecker.getContentType).toHaveBeenCalledWith(
      'https://gateway.example.test/rememe.png'
    );
    expect(withArweaveFallback).toHaveBeenCalledWith(
      'https://gateway.example.test/rememe.png',
      expect.any(Function)
    );
    expect(PutObjectCommand).toHaveBeenCalledTimes(4);
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_processing_status: RememeS3ProcessingStatus.COMPLETE
      })
    ]);
  });

  it('fetches through the public transport with a byte cap and records oversize', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('png');
    jest
      .mocked(publicFetch)
      .mockRejectedValue(
        new PublicResponseTooLargeError(104857600, 200000000, 'content-length')
      );

    await persistRememesS3([buildRememe()]);

    expect(publicFetch).toHaveBeenCalledWith(
      'https://example.test/rememe.png',
      expect.objectContaining({ method: 'GET', maxBytes: 100 * 1024 * 1024 })
    );
    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: null,
        s3_image_processing_status: RememeS3ProcessingStatus.TRANSIENT_ERROR,
        s3_image_processing_attempts: 1,
        s3_image_processing_error: expect.stringContaining('byte limit')
      })
    ]);
  });

  it('stores the original with the decoded format, not the probed one', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('image/gif');
    jest.mocked(detectRasterImageFormat).mockResolvedValue('jpeg');
    jest
      .mocked(publicFetch)
      .mockResolvedValue(buildFetchResponse({ body: Buffer.from('jpeg') }));
    jest
      .mocked(resizeImageBufferToHeight)
      .mockResolvedValue(Buffer.from('resized-image'));

    await persistRememesS3([buildRememe()]);

    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Key: `rememes/images/original/${BASE_KEY}jpeg`,
        ContentType: 'image/jpeg'
      })
    );
    expect(PutObjectCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Key: `rememes/images/scaled/${BASE_KEY}webp`,
        ContentType: 'image/webp'
      })
    );
  });

  it('does not store an original whose bytes are not an image', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('image/png');
    jest.mocked(detectRasterImageFormat).mockResolvedValue(null);
    jest
      .mocked(publicFetch)
      .mockResolvedValue(
        buildFetchResponse({ body: Buffer.from('<html></html>') })
      );

    await persistRememesS3([buildRememe()]);

    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: null,
        s3_image_processing_status: RememeS3ProcessingStatus.TRANSIENT_ERROR,
        s3_image_processing_error: 'Rememe media is not a supported image'
      })
    ]);
  });

  it.each([
    [
      'mp4',
      Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'),
      'mp4',
      'video/mp4'
    ],
    [
      'webm',
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from('....webm')
      ]),
      'webm',
      'video/webm'
    ]
  ])(
    'stores a %s original typed from its container',
    async (probed, bytes, extension, contentType) => {
      mockS3Objects({});
      jest
        .mocked(mediaChecker.getContentType)
        .mockResolvedValue(`video/${probed}`);
      jest
        .mocked(publicFetch)
        .mockResolvedValue(buildFetchResponse({ body: bytes }));

      await persistRememesS3([buildRememe()]);

      expect(PutObjectCommand).toHaveBeenCalledTimes(1);
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: `rememes/images/original/${BASE_KEY}${extension}`,
          ContentType: contentType
        })
      );
    }
  );

  it('does not store a video original whose bytes are not a known container', async () => {
    mockS3Objects({});
    jest.mocked(mediaChecker.getContentType).mockResolvedValue('video/mp4');
    jest
      .mocked(publicFetch)
      .mockResolvedValue(buildFetchResponse({ body: Buffer.from('<svg/>') }));

    await persistRememesS3([buildRememe()]);

    expect(PutObjectCommand).not.toHaveBeenCalled();
    expect(persistRememes).toHaveBeenCalledWith([
      expect.objectContaining({
        s3_image_original: null,
        s3_image_processing_status: RememeS3ProcessingStatus.UNSUPPORTED
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
  const storedKeys = new Set(
    Object.values(objectsByPrefix).flatMap((keys) => keys)
  );
  sendMock.mockImplementation(async (command) => {
    if (command.commandName === 'ListObjectsV2Command') {
      return {
        Contents: Array.from(storedKeys)
          .filter((Key) => Key.startsWith(command.input.Prefix))
          .map((Key) => ({ Key }))
      };
    }

    if (command.commandName === 'PutObjectCommand') {
      storedKeys.add(command.input.Key);
    }

    return {
      $metadata: {
        httpStatusCode: 200
      }
    };
  });
}

function buildFetchResponse({
  body,
  contentType
}: {
  body?: Buffer;
  contentType?: string;
}) {
  return {
    ok: true,
    status: 200,
    finalUrl: 'https://example.test/rememe.png',
    headers: {
      get: (name: string) =>
        name === 'content-type' ? (contentType ?? null) : null
    } as never,
    body: body ?? Buffer.alloc(0)
  };
}
