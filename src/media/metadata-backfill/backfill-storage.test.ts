import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { InMemoryObjectStore } from '@/tests/fixtures/media-object-store.fixture';
import {
  assertRunId,
  assertSafetyLocation,
  newRunId,
  ObjectChangedError,
  S3MediaObjectStore,
  SafetyCopyLayout,
  sha256Base64
} from './backfill-storage';

function s3With(send: jest.Mock): S3Client {
  return { send } as unknown as S3Client;
}

const body = (bytes: Buffer) => ({
  transformToByteArray: async () => new Uint8Array(bytes)
});

describe('S3MediaObjectStore', () => {
  it('reads headers and metadata from HeadObject', async () => {
    const send = jest.fn().mockResolvedValue({
      ETag: '"e"',
      ContentLength: 3,
      ContentType: 'image/png',
      CacheControl: 'max-age=1',
      ContentDisposition: 'inline',
      StorageClass: 'INTELLIGENT_TIERING',
      Metadata: { 'format-validated': 'true' }
    });
    const head = await new S3MediaObjectStore(s3With(send), 'b').head('k');
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'b',
      Key: 'k',
      ChecksumMode: 'ENABLED'
    });
    expect(head).toMatchObject({
      etag: '"e"',
      size: 3,
      headers: {
        contentType: 'image/png',
        cacheControl: 'max-age=1',
        contentDisposition: 'inline',
        storageClass: 'INTELLIGENT_TIERING',
        metadata: { 'format-validated': 'true' }
      }
    });
  });

  it('returns null for a missing object', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { name: 'NotFound' }));
    expect(
      await new S3MediaObjectStore(s3With(send), 'b').head('k')
    ).toBeNull();
  });

  it('writes every header with a checksum and a condition', async () => {
    const send = jest.fn().mockResolvedValue({});
    const bytes = Buffer.from('abc');
    await new S3MediaObjectStore(s3With(send), 'b').put(
      'k',
      bytes,
      {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
        contentDisposition: 'inline',
        contentLanguage: 'en',
        metadata: { 'privacy-sanitized': 'true' }
      },
      { ifMatch: '"old"' }
    );
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'b',
      Key: 'k',
      Body: bytes,
      ContentLength: 3,
      ChecksumSHA256: sha256Base64(bytes),
      IfMatch: '"old"',
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
      ContentDisposition: 'inline',
      ContentLanguage: 'en',
      Metadata: { 'privacy-sanitized': 'true' }
    });
  });

  it('maps failed conditions to ObjectChangedError', async () => {
    const failed = Object.assign(new Error('x'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 }
    });
    const store = new S3MediaObjectStore(
      s3With(jest.fn().mockRejectedValue(failed)),
      'b'
    );
    await expect(
      store.put('k', Buffer.from('a'), { metadata: {} }, { ifMatch: '"e"' })
    ).rejects.toBeInstanceOf(ObjectChangedError);
    await expect(
      store.getBytes('k', { ifMatch: '"e"', maxBytes: 10 })
    ).rejects.toBeInstanceOf(ObjectChangedError);
  });

  it('reads bodies conditionally and refuses oversized or short reads', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        ContentLength: 3,
        Body: body(Buffer.from('abc'))
      })
      .mockResolvedValueOnce({
        ContentLength: 30,
        Body: body(Buffer.alloc(30))
      })
      .mockResolvedValueOnce({
        ContentLength: 5,
        Body: body(Buffer.from('abc'))
      });
    const store = new S3MediaObjectStore(s3With(send), 'b');
    expect(
      (await store.getBytes('k', { ifMatch: '"e"', maxBytes: 10 })).toString()
    ).toBe('abc');
    expect((send.mock.calls[0][0] as GetObjectCommand).input).toMatchObject({
      IfMatch: '"e"'
    });
    await expect(store.getBytes('k', { maxBytes: 10 })).rejects.toThrow(
      'larger'
    );
    await expect(store.getBytes('k', { maxBytes: 10 })).rejects.toThrow(
      'Short read'
    );
  });

  it('reports versioning read-only, and unknown when it cannot', async () => {
    const versioned = new S3MediaObjectStore(
      s3With(jest.fn().mockResolvedValue({ Status: 'Enabled' })),
      'b'
    );
    expect(await versioned.versioningStatus()).toBe('Enabled');
    const never = new S3MediaObjectStore(
      s3With(jest.fn().mockResolvedValue({})),
      'b'
    );
    expect(await never.versioningStatus()).toBe('Disabled');
    const denied = new S3MediaObjectStore(
      s3With(jest.fn().mockRejectedValue(new Error('AccessDenied'))),
      'b'
    );
    expect(await denied.versioningStatus()).toBe('unknown');
  });
});

describe('SafetyCopyLayout and run ids', () => {
  it('keeps each run under its stage prefix', () => {
    const layout = new SafetyCopyLayout('prod', '20261116T120000Z-0a1b2c3d');
    expect(layout.runPrefix).toBe(
      'prod/backfill-originals/20261116T120000Z-0a1b2c3d/'
    );
    expect(layout.objectKey('drops/a/b.jpg')).toBe(
      'prod/backfill-originals/20261116T120000Z-0a1b2c3d/objects/drops/a/b.jpg'
    );
    expect(layout.manifestKey('drops/a/b.jpg')).toBe(
      'prod/backfill-originals/20261116T120000Z-0a1b2c3d/manifest/drops/a/b.jpg.json'
    );
    expect(() => new SafetyCopyLayout('prod/drop-media-ingest', 'x')).toThrow(
      'stage'
    );
    expect(() => new SafetyCopyLayout('prod', '')).toThrow('run id');
  });

  it('generates and validates run ids', () => {
    const id = newRunId(new Date('2026-11-16T12:34:56.789Z'), 'deadbeef');
    expect(id).toBe('20261116T123456Z-deadbeef');
    expect(assertRunId(id)).toBe(id);
    expect(() => assertRunId('../other')).toThrow();
  });
});

describe('assertSafetyLocation', () => {
  const layout = new SafetyCopyLayout('prod', '20261116T120000Z-0a1b2c3d');

  it('accepts a private bucket with no expiration over the run prefix', async () => {
    const safety = new InMemoryObjectStore('private');
    safety.lifecycle = [
      { prefix: 'prod/drop-media-ingest/', days: 3 },
      { prefix: 'staging/wave-media-ingest/', days: 3 }
    ];
    await expect(
      assertSafetyLocation(safety, new InMemoryObjectStore('public'), layout)
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'the public bucket',
      (s: InMemoryObjectStore) => s,
      'must not be the public bucket'
    ],
    [
      'a bucket without full public access blocks',
      (s: InMemoryObjectStore) => {
        s.publicAccessBlocked = false;
        return new InMemoryObjectStore('public');
      },
      'blocks all public access'
    ],
    [
      'unreadable lifecycle rules',
      (s: InMemoryObjectStore) => {
        s.lifecycle = null;
        return new InMemoryObjectStore('public');
      },
      'lifecycle rules'
    ],
    [
      'an expiration covering the prefix',
      (s: InMemoryObjectStore) => {
        s.lifecycle = [{ prefix: '', days: 30 }];
        return new InMemoryObjectStore('public');
      },
      'expire on their own'
    ]
  ])('refuses %s', async (_name, arrange, message) => {
    const safety = new InMemoryObjectStore('private');
    const publicStore = arrange(safety);
    await expect(
      assertSafetyLocation(safety, publicStore, layout)
    ).rejects.toThrow(message);
  });
});
