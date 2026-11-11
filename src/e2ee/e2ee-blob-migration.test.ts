import { randomBytes } from 'node:crypto';
import {
  E2eeBlobMigrationDb,
  migrateE2eeBlobsToS3
} from '@/e2ee/e2ee-blob-migration';
import { S3E2eeBlobStore } from '@/e2ee/e2ee-blob-store.s3';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const BUCKET = 'private-bucket';
const PREFIX = 'staging/e2ee-blobs';

interface FakeBlob {
  storage: 'mysql' | 's3';
  readonly size: number;
  readonly chunks: (Buffer | null)[];
  deleted?: boolean;
}

function blobId(n: number): string {
  return `0x${n.toString(16).padStart(32, '0')}`;
}

function fakeDb(blobs: Map<string, FakeBlob>) {
  const db: jest.Mocked<E2eeBlobMigrationDb> = {
    getBlobStorageInventory: jest.fn(async () => [
      {
        storage: 'mysql',
        complete: true,
        blobs: blobs.size,
        bytes: Array.from(blobs.values()).reduce((sum, b) => sum + b.size, 0)
      }
    ]),
    getMigratableBlobs: jest.fn(
      async (after: string, limit: number, _minCreatedAt: number) =>
        Array.from(blobs.entries())
          .filter(([id, blob]) => blob.storage === 'mysql' && id > after)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit)
          .map(([id, blob]) => ({
            blob_id: id,
            size: blob.size,
            chunk_count: blob.chunks.length
          }))
    ),
    getBlob: jest.fn(async (id: string) => {
      const blob = blobs.get(id);
      return blob && !blob.deleted
        ? ({ blob_id: id, storage: blob.storage } as never)
        : null;
    }),
    getBlobChunkBytes: jest.fn(async (id: string) =>
      (blobs.get(id)?.chunks ?? []).map((chunk, index) => ({
        chunk_index: index,
        size: chunk?.length ?? 0,
        data_b64: chunk ? chunk.toString('base64') : ''
      }))
    ),
    switchBlobToS3: jest.fn(
      async (
        id: string,
        _sizes: readonly number[],
        _location: string,
        _minCreatedAt: number
      ): Promise<'switched' | 'gone' | 'changed'> => {
        const blob = blobs.get(id);
        if (!blob || blob.deleted) return 'gone';
        blob.storage = 's3';
        blob.chunks.fill(null);
        return 'switched';
      }
    )
  };
  return db;
}

function setup(blobCount: number) {
  const blobs = new Map<string, FakeBlob>();
  for (let n = 1; n <= blobCount; n++) {
    const chunks = [randomBytes(16), randomBytes(5)];
    blobs.set(blobId(n), { storage: 'mysql', size: 21, chunks });
  }
  const s3 = new InMemoryE2eeBlobS3(BUCKET);
  const target = new S3E2eeBlobStore(
    { bucket: BUCKET, prefix: PREFIX, region: 'eu-west-1' },
    s3,
    { upsertBlobChunk: jest.fn(), getBlobChunkData: jest.fn() }
  );
  const db = fakeDb(blobs);
  return { blobs, s3, target, db };
}

describe('migrateE2eeBlobsToS3', () => {
  it('reports without writing anything in a dry run', async () => {
    const { s3, target, db } = setup(3);

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      { live: false, limit: 100 }
    );

    expect(report).toMatchObject({
      mode: 'dry-run',
      target: { bucket: BUCKET, prefix: PREFIX, region: 'eu-west-1' },
      examined: 3,
      migrated: 3,
      bytes: 63,
      failures: [],
      more: false
    });
    expect(s3.objects.size).toBe(0);
    expect(db.switchBlobToS3).not.toHaveBeenCalled();
  });

  it('copies, verifies and switches each blob, and is idempotent', async () => {
    const { blobs, s3, target, db } = setup(2);
    const original = blobs.get(blobId(1))!.chunks.map((chunk) => chunk!);

    const first = await migrateE2eeBlobsToS3(
      { db, target },
      { live: true, limit: 100 }
    );

    expect(first).toMatchObject({ mode: 'live', migrated: 2, failures: [] });
    expect(s3.objects.get(`${PREFIX}/${blobId(1)}/0`)?.body).toEqual(
      original[0]
    );
    expect(db.switchBlobToS3).toHaveBeenCalledWith(
      blobId(1),
      [16, 5],
      `s3://${BUCKET}/${PREFIX}`,
      expect.any(Number)
    );
    expect(blobs.get(blobId(2))!.storage).toBe('s3');

    const second = await migrateE2eeBlobsToS3(
      { db, target },
      { live: true, limit: 100 }
    );
    expect(second).toMatchObject({ examined: 0, migrated: 0 });
  });

  it('does not switch a blob whose copy reads back differently', async () => {
    const { blobs, s3, target, db } = setup(1);
    const realSend = s3.send.bind(s3);
    jest.spyOn(s3, 'send').mockImplementation(async (command) => {
      const result = await realSend(command);
      if (result?.Body) {
        return {
          Body: { transformToByteArray: async () => new Uint8Array([1, 2]) }
        };
      }
      return result;
    });

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      { live: true, limit: 100 }
    );

    expect(report.migrated).toBe(0);
    expect(report.failures).toEqual([
      { blob_id: blobId(1), reason: 'chunk 0 hash differs after upload' }
    ]);
    expect(db.switchBlobToS3).not.toHaveBeenCalled();
    expect(blobs.get(blobId(1))!.storage).toBe('mysql');
    // The unverified copies are removed.
    expect(s3.objects.size).toBe(0);
  });

  it('skips blobs whose chunks do not match their row', async () => {
    const { blobs, target, db } = setup(2);
    blobs.get(blobId(1))!.chunks.pop();
    blobs.get(blobId(2))!.chunks[1] = null;

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      { live: true, limit: 100 }
    );

    expect(report.failures.map((failure) => failure.blob_id)).toEqual([
      blobId(1),
      blobId(2)
    ]);
    expect(db.switchBlobToS3).not.toHaveBeenCalled();
  });

  it('removes the copies of a blob that retention deleted meanwhile', async () => {
    const { blobs, s3, target, db } = setup(1);
    blobs.get(blobId(1))!.deleted = true;

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      { live: true, limit: 100 }
    );

    expect(report).toMatchObject({ migrated: 0, vanished: 1, failures: [] });
    expect(s3.objects.size).toBe(0);
  });

  it('stops starting blobs once the time budget is spent', async () => {
    const { target, db } = setup(3);
    let clock = 0;

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      {
        live: true,
        limit: 100,
        timeBudgetMs: 1000,
        now: () => {
          clock += 400;
          return clock;
        }
      }
    );

    expect(report.examined).toBeLessThan(3);
    expect(report.more).toBe(true);
  });

  it('leaves blobs near their retention cutoff to retention', async () => {
    const { target, db } = setup(1);
    const now = 2_000_000_000_000;

    await migrateE2eeBlobsToS3(
      { db, target },
      { live: false, limit: 10, now: () => now }
    );

    expect(db.getMigratableBlobs).toHaveBeenCalledWith(
      '',
      10,
      now - 364 * 24 * 60 * 60 * 1000
    );
  });

  it('stops at the limit and says more remain', async () => {
    const { target, db } = setup(5);

    const report = await migrateE2eeBlobsToS3(
      { db, target },
      { live: false, limit: 2 }
    );

    expect(report).toMatchObject({ examined: 2, migrated: 2, more: true });
  });

  it('checks the bucket before touching any blob', async () => {
    const { db } = setup(1);
    const target = new S3E2eeBlobStore(
      { bucket: 'other-bucket', prefix: PREFIX, region: 'eu-west-1' },
      new InMemoryE2eeBlobS3(BUCKET),
      { upsertBlobChunk: jest.fn(), getBlobChunkData: jest.fn() }
    );

    await expect(
      migrateE2eeBlobsToS3({ db, target }, { live: true, limit: 100 })
    ).rejects.toThrow('NoSuchBucket');
    expect(db.getMigratableBlobs).not.toHaveBeenCalled();
  });
});
