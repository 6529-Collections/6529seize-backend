import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import {
  e2eeBlobObjectKey,
  isMissingS3Object,
  S3E2eeBlobStore
} from '@/e2ee/e2ee-blob-store.s3';
import {
  E2eeBlobChunkRows,
  E2eeBlobStorageError
} from '@/e2ee/e2ee-blob-store';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const BUCKET = 'private-bucket';
const CONFIG = {
  bucket: BUCKET,
  prefix: 'staging/e2ee-blobs',
  region: 'eu-west-1'
};
const BLOB_ID = `0x${'ab'.repeat(16)}`;
const CONNECTION = { connection: {} } as never;

function rowsFake() {
  const upserts: Parameters<E2eeBlobChunkRows['upsertBlobChunk']>[0][] = [];
  const rows: E2eeBlobChunkRows = {
    upsertBlobChunk: jest.fn(async (input) => {
      upserts.push(input);
    }),
    getBlobChunkData: jest.fn(async () => null)
  };
  return { rows, upserts };
}

describe('S3E2eeBlobStore', () => {
  it('writes a private, encrypted, checksummed object and records only the size', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    const { rows, upserts } = rowsFake();
    const store = new S3E2eeBlobStore(CONFIG, s3, rows);
    const data = randomBytes(1024);

    await store.putChunk(
      { blobId: BLOB_ID, index: 3, data, createdAt: 42 },
      CONNECTION
    );

    const put = s3.commands[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toEqual({
      Bucket: BUCKET,
      Key: `staging/e2ee-blobs/${BLOB_ID}/3`,
      Body: data,
      ContentLength: 1024,
      ContentType: 'application/octet-stream',
      CacheControl: 'private, no-store',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: createHash('sha256').update(data).digest('base64')
    });
    expect(put.input).not.toHaveProperty('ACL');
    expect(upserts).toEqual([
      {
        blobId: BLOB_ID,
        index: 3,
        data: Buffer.alloc(0),
        size: 1024,
        createdAt: 42
      }
    ]);
    expect(rows.upsertBlobChunk).toHaveBeenCalledWith(
      expect.anything(),
      CONNECTION
    );
  });

  it('records nothing when S3 refuses the upload', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    s3.failNext = { command: 'PutObject', error: new Error('AccessDenied') };
    const { rows } = rowsFake();
    const store = new S3E2eeBlobStore(CONFIG, s3, rows);

    await expect(
      store.putChunk(
        { blobId: BLOB_ID, index: 0, data: randomBytes(8), createdAt: 1 },
        CONNECTION
      )
    ).rejects.toThrow(E2eeBlobStorageError);
    expect(rows.upsertBlobChunk).not.toHaveBeenCalled();
  });

  it('reads chunks back with checksum validation and returns null when missing', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    const store = new S3E2eeBlobStore(CONFIG, s3, rowsFake().rows);
    const data = randomBytes(64);
    await store.putObject(BLOB_ID, 0, data);

    expect((await store.getChunk(BLOB_ID, 0))?.equals(data)).toBe(true);
    const get = s3.commands[1] as GetObjectCommand;
    expect(get.input).toEqual({
      Bucket: BUCKET,
      Key: `staging/e2ee-blobs/${BLOB_ID}/0`,
      ChecksumMode: 'ENABLED'
    });
    expect(await store.getChunk(BLOB_ID, 1)).toBeNull();
  });

  it('surfaces S3 errors other than a missing object', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    s3.failNext = {
      command: 'GetObject',
      error: Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 }
      })
    };
    const store = new S3E2eeBlobStore(CONFIG, s3, rowsFake().rows);

    await expect(store.getChunk(BLOB_ID, 0)).rejects.toThrow(
      'S3 GetObject failed: AccessDenied: Access Denied'
    );
  });

  it('treats a missing bucket as a storage failure, not a missing chunk', async () => {
    const store = new S3E2eeBlobStore(
      { ...CONFIG, bucket: 'deleted-bucket' },
      new InMemoryE2eeBlobS3(BUCKET),
      rowsFake().rows
    );

    await expect(store.getChunk(BLOB_ID, 0)).rejects.toThrow(
      E2eeBlobStorageError
    );
  });

  it('lets database errors from the size row through unwrapped', async () => {
    const { rows } = rowsFake();
    jest
      .mocked(rows.upsertBlobChunk)
      .mockRejectedValueOnce(
        Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' })
      );
    const store = new S3E2eeBlobStore(
      CONFIG,
      new InMemoryE2eeBlobS3(BUCKET),
      rows
    );

    const failure = await store
      .putChunk(
        { blobId: BLOB_ID, index: 0, data: randomBytes(8), createdAt: 1 },
        CONNECTION
      )
      .catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(E2eeBlobStorageError);
    expect((failure as { code?: string }).code).toBe('ER_LOCK_DEADLOCK');
  });

  it('names its location as bucket plus prefix', () => {
    expect(
      new S3E2eeBlobStore(
        CONFIG,
        new InMemoryE2eeBlobS3(BUCKET),
        rowsFake().rows
      ).location
    ).toBe('s3://private-bucket/staging/e2ee-blobs');
  });

  it('deletes every chunk key of each blob in batches of 1000', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    const store = new S3E2eeBlobStore(CONFIG, s3, rowsFake().rows);
    const blobs = Array.from({ length: 41 }, (_, i) => ({
      blob_id: `0x${i.toString(16).padStart(32, '0')}`,
      chunk_count: 25
    }));
    for (const blob of blobs.slice(0, 2)) {
      await store.putObject(blob.blob_id, 24, randomBytes(4));
    }

    await store.deleteBlobs(blobs);

    const deletes = s3.commands.filter(
      (command): command is DeleteObjectsCommand =>
        command instanceof DeleteObjectsCommand
    );
    expect(
      deletes.map((command) => command.input.Delete?.Objects?.length)
    ).toEqual([1000, 25]);
    expect(deletes[0].input.Delete?.Objects?.[0]).toEqual({
      Key: `staging/e2ee-blobs/${blobs[0].blob_id}/0`
    });
    expect(s3.objects.size).toBe(0);
  });

  it('fails the delete when S3 reports per-key errors', async () => {
    const send = jest.fn(async () => ({
      Errors: [{ Key: 'k', Code: 'AccessDenied' }]
    }));
    const store = new S3E2eeBlobStore(
      CONFIG,
      { send } as never,
      rowsFake().rows
    );

    await expect(
      store.deleteBlobs([{ blob_id: BLOB_ID, chunk_count: 1 }])
    ).rejects.toThrow('S3 did not delete 1 encrypted attachment objects');
  });

  it('builds keys only from valid blob ids and chunk indexes', () => {
    expect(e2eeBlobObjectKey('p', BLOB_ID, 0)).toBe(`p/${BLOB_ID}/0`);
    expect(() => e2eeBlobObjectKey('p', '../etc', 0)).toThrow();
    expect(() => e2eeBlobObjectKey('p', BLOB_ID.toUpperCase(), 0)).toThrow();
    expect(() => e2eeBlobObjectKey('p', BLOB_ID, -1)).toThrow();
    expect(() => e2eeBlobObjectKey('p', BLOB_ID, 1.5)).toThrow();
  });

  it('recognizes missing-object errors', () => {
    expect(isMissingS3Object({ name: 'NoSuchKey' })).toBe(true);
    expect(isMissingS3Object({ Code: 'NoSuchKey' })).toBe(true);
    expect(
      isMissingS3Object({
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 }
      })
    ).toBe(false);
    expect(isMissingS3Object({ name: 'AccessDenied' })).toBe(false);
    expect(isMissingS3Object(undefined)).toBe(false);
  });
});
