import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { EntityManager } from 'typeorm';
import type { NextGenToken } from '../entities/INextGen';
import { handler as mediaProxyHandler } from '../nextgenMediaProxyInterceptor';
import {
  fetchPendingNextgenThumbnails,
  persistNextGenToken
} from './nextgen.db';
import { listS3Objects, s3UploadNextgenImage } from './nextgen_generator';
import { processMissingThumbnails } from './nextgen_pending_thumbnails';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),
  S3Client: jest.fn(() => ({ send: mockSend }))
}));
jest.mock('../logging', () => ({
  Logger: { get: () => ({ info: jest.fn(), error: jest.fn() }) }
}));
jest.mock('./nextgen.db', () => ({
  fetchPendingNextgenThumbnails: jest.fn(),
  persistNextGenToken: jest.fn()
}));

const originalChainId = process.env.NEXTGEN_CHAIN_ID;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
});

afterEach(() => {
  if (originalChainId === undefined) {
    delete process.env.NEXTGEN_CHAIN_ID;
  } else {
    process.env.NEXTGEN_CHAIN_ID = originalChainId;
  }
});

it('lists every page from the storage bucket behind the public CDN', async () => {
  mockSend
    .mockResolvedValueOnce({
      Contents: [{ Key: 'mainnet/png/10000000000' }],
      IsTruncated: true,
      NextContinuationToken: 'next-page'
    })
    .mockResolvedValueOnce({
      Contents: [{ Key: 'mainnet/png/10000000001' }],
      IsTruncated: false
    });

  const result = await listS3Objects(new S3Client({}), 'mainnet/png/');

  expect(result).toEqual([10000000000, 10000000001]);
  expect(mockSend).toHaveBeenCalledTimes(2);
  for (const [command] of mockSend.mock.calls) {
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input).toMatchObject({
      Bucket: 'media.generator.seize.io',
      Prefix: 'mainnet/png/'
    });
  }
  expect(mockSend.mock.calls[1][0].input.ContinuationToken).toBe('next-page');
});

it('uploads generated images to the existing storage bucket', async () => {
  mockSend.mockResolvedValue({});
  const image = Buffer.from('synthetic-image');

  await s3UploadNextgenImage(
    new S3Client({}),
    image,
    'mainnet/png/10000000000'
  );

  expect(mockSend).toHaveBeenCalledTimes(1);
  const command = mockSend.mock.calls[0][0];
  expect(command).toBeInstanceOf(PutObjectCommand);
  expect(command.input).toEqual({
    Bucket: 'media.generator.seize.io',
    Key: 'mainnet/png/10000000000',
    Body: image,
    ContentType: 'image/png'
  });
});

it.each([
  ['1', 'mainnet'],
  ['11155111', 'testnet']
])(
  'keeps public thumbnail URLs on the CDN for chain %s',
  async (chain, path) => {
    process.env.NEXTGEN_CHAIN_ID = chain;
    const token = { id: 10000000000 } as NextGenToken;
    const manager = {} as EntityManager;
    jest.mocked(fetchPendingNextgenThumbnails).mockResolvedValue([token]);
    mockSend.mockImplementation(async (command: ListObjectsV2Command) => ({
      Contents: [{ Key: `${command.input.Prefix}${token.id}` }],
      IsTruncated: false
    }));

    await processMissingThumbnails(manager);

    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const [command] of mockSend.mock.calls) {
      expect(command.input.Bucket).toBe('media.generator.seize.io');
    }
    expect(persistNextGenToken).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        id: token.id,
        icon_url: `https://media.generator.6529.io/${path}/thumbnail/${token.id}`,
        thumbnail_url: `https://media.generator.6529.io/${path}/png0.5k/${token.id}`
      })
    );
  }
);

it('keeps proxy placeholder responses on the public CDN', async () => {
  const result = await mediaProxyHandler({
    Records: [
      {
        cf: {
          request: { uri: '/mainnet/metadata/10000000000' },
          response: { status: '403', headers: {} }
        }
      }
    ]
  });

  expect(result.status).toBe('200');
  expect(JSON.parse(result.body).image).toBe(
    'https://media.generator.6529.io/placeholders/mainnet/1.png'
  );
});
