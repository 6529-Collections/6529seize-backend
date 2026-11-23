import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  marketDepthArchiveStateKey,
  marketDepthArchiveStoreFromEnv,
  S3MarketDepthArchiveStore
} from './market-depth-archive-store';

const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';

function storeWith(send: jest.Mock) {
  return new S3MarketDepthArchiveStore('archive-bucket', {
    send
  } as unknown as S3Client);
}

describe('S3 market-depth archive store', () => {
  const previousBucket = process.env.MARKET_DEPTH_ARCHIVE_BUCKET;
  afterEach(() => {
    if (previousBucket === undefined)
      delete process.env.MARKET_DEPTH_ARCHIVE_BUCKET;
    else process.env.MARKET_DEPTH_ARCHIVE_BUCKET = previousBucket;
  });

  it('reads a missing watermark as nothing archived', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new NoSuchKey({ message: 'missing', $metadata: {} }));
    await expect(
      storeWith(send).getArchivedThrough('events', CONTRACT)
    ).resolves.toBeNull();
    const command = send.mock.calls[0][0] as GetObjectCommand;
    expect(command.input).toEqual({
      Bucket: 'archive-bucket',
      Key: `market-depth/v1/_state/events/contract=${CONTRACT}.json`
    });
  });

  it('reads a stored watermark and rejects a corrupt one', async () => {
    const body = (text: string) => ({
      Body: { transformToString: async () => text }
    });
    const send = jest
      .fn()
      .mockResolvedValueOnce(
        body('{"archived_through":"2026-11-22T10:00:00.000Z"}')
      )
      .mockResolvedValueOnce(body('{"archived_through":"soon"}'));
    const store = storeWith(send);
    await expect(
      store.getArchivedThrough('snapshots', CONTRACT)
    ).resolves.toEqual(new Date('2026-11-22T10:00:00.000Z'));
    await expect(
      store.getArchivedThrough('snapshots', CONTRACT)
    ).rejects.toThrow('Invalid market-depth archive state');
  });

  it('propagates access errors instead of treating them as missing', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('denied'), { name: 'AccessDenied' })
      );
    await expect(
      storeWith(send).getArchivedThrough('events', CONTRACT)
    ).rejects.toThrow('denied');
  });

  it('writes watermarks and checksummed objects', async () => {
    const send = jest.fn().mockResolvedValue({});
    const store = storeWith(send);
    await store.setArchivedThrough(
      'events',
      CONTRACT.toUpperCase().replace('0X', '0x'),
      new Date('2026-11-22T11:00:00.000Z')
    );
    await store.putObject({
      key: 'market-depth/v1/events/x.jsonl.gz',
      body: Buffer.from('x'),
      contentType: 'application/gzip',
      metadata: { rows: '1' }
    });
    const [state, object] = send.mock.calls.map(
      ([command]) => (command as PutObjectCommand).input
    );
    expect(state).toMatchObject({
      Bucket: 'archive-bucket',
      Key: marketDepthArchiveStateKey('events', CONTRACT),
      ContentType: 'application/json'
    });
    expect(JSON.parse(state.Body as string)).toMatchObject({
      archived_through: '2026-11-22T11:00:00.000Z'
    });
    expect(object).toMatchObject({
      Key: 'market-depth/v1/events/x.jsonl.gz',
      ContentType: 'application/gzip',
      Metadata: { rows: '1' },
      ChecksumAlgorithm: 'SHA256'
    });
  });

  it('is disabled when no bucket is configured', () => {
    process.env.MARKET_DEPTH_ARCHIVE_BUCKET = '';
    expect(marketDepthArchiveStoreFromEnv()).toBeNull();
    process.env.MARKET_DEPTH_ARCHIVE_BUCKET = 'archive-bucket';
    expect(marketDepthArchiveStoreFromEnv()).toBeInstanceOf(
      S3MarketDepthArchiveStore
    );
  });
});
