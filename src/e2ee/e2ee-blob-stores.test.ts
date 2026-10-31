import { randomBytes } from 'node:crypto';
import { E2eeBlobChunkRows } from '@/e2ee/e2ee-blob-store';
import {
  createE2eeBlobStores,
  deleteStoredE2eeBlobs,
  E2eeBlobStores
} from '@/e2ee/e2ee-blob-stores';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const BUCKET = 'private-bucket';
const S3_ENV = {
  E2EE_BLOB_STORE: 's3',
  E2EE_BLOB_S3_BUCKET: BUCKET,
  E2EE_BLOB_S3_PREFIX: 'test/e2ee-blobs'
};
const LOCATION = 's3://private-bucket/test/e2ee-blobs';
const S3_BLOB = { storage: 's3', storage_location: LOCATION };

function rows(): E2eeBlobChunkRows {
  return {
    upsertBlobChunk: jest.fn(async () => undefined),
    getBlobChunkData: jest.fn(async () => null)
  };
}

function expectStorageUnavailable(action: () => unknown) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  expect((caught as E2eeApiException).getStatusCode()).toBe(503);
  expect((caught as E2eeApiException).e2eeCode).toBe(
    'E2EE_STORAGE_UNAVAILABLE'
  );
}

describe('createE2eeBlobStores', () => {
  it('uses MySQL for new blobs by default', () => {
    const stores = createE2eeBlobStores({ rows: rows(), env: () => ({}) });
    expect(stores.forNewBlob().storage).toBe('mysql');
    expect(stores.forBlob({ storage: null }).storage).toBe('mysql');
  });

  it('uses S3 for new blobs once switched, reading settings on every call', () => {
    let env: Record<string, string> = {};
    const s3Client = jest.fn(() => new InMemoryE2eeBlobS3(BUCKET));
    const stores = createE2eeBlobStores({
      rows: rows(),
      env: () => env,
      s3Client
    });
    expect(stores.forNewBlob().storage).toBe('mysql');
    env = S3_ENV;
    expect(stores.forNewBlob().storage).toBe('s3');
    expect(stores.forNewBlob().location).toBe(LOCATION);
    expect(stores.forBlob(S3_BLOB)).toBe(stores.forNewBlob());
    expect(s3Client).toHaveBeenCalledTimes(1);
    expect(s3Client).toHaveBeenCalledWith('eu-west-1');
  });

  it('refuses new blobs instead of falling back when S3 is misconfigured', () => {
    const stores = createE2eeBlobStores({
      rows: rows(),
      env: () => ({ E2EE_BLOB_STORE: 's3' })
    });
    expectStorageUnavailable(() => stores.forNewBlob());
  });

  it('refuses new blobs for an unknown store', () => {
    const stores = createE2eeBlobStores({
      rows: rows(),
      env: () => ({ E2EE_BLOB_STORE: 'disk' })
    });
    expectStorageUnavailable(() => stores.forNewBlob());
  });

  it('keeps serving MySQL blobs but fails S3 blobs closed without S3 settings', () => {
    const stores = createE2eeBlobStores({ rows: rows(), env: () => ({}) });
    expect(stores.forBlob({ storage: 'mysql' }).storage).toBe('mysql');
    expectStorageUnavailable(() => stores.forBlob(S3_BLOB));
    expectStorageUnavailable(() => stores.forBlob({ storage: 'ipfs' }));
  });

  it('never reads or deletes an S3 blob written to another location', () => {
    const stores = createE2eeBlobStores({
      rows: rows(),
      env: () => ({ ...S3_ENV, E2EE_BLOB_S3_PREFIX: 'test/moved' }),
      s3Client: () => new InMemoryE2eeBlobS3(BUCKET)
    });
    expectStorageUnavailable(() => stores.forBlob(S3_BLOB));
    expectStorageUnavailable(() =>
      stores.forBlob({ storage: 's3', storage_location: null })
    );
    expectStorageUnavailable(() =>
      stores.forBlob({ storage: 'mysql', storage_location: LOCATION })
    );
  });
});

describe('deleteStoredE2eeBlobs', () => {
  it('deletes S3 objects and reports every blob whose bytes are gone', async () => {
    const s3 = new InMemoryE2eeBlobS3(BUCKET);
    const stores = createE2eeBlobStores({
      rows: rows(),
      env: () => S3_ENV,
      s3Client: () => s3
    });
    const s3Blob = `0x${'01'.repeat(16)}`;
    await stores
      .forBlob(S3_BLOB)
      .putChunk(
        { blobId: s3Blob, index: 0, data: randomBytes(4), createdAt: 1 },
        {} as never
      );

    const deleted = await deleteStoredE2eeBlobs(stores, [
      { blob_id: s3Blob, chunk_count: 1, ...S3_BLOB },
      { blob_id: `0x${'02'.repeat(16)}`, chunk_count: 3, storage: 'mysql' }
    ]);

    expect(deleted.sort((a, b) => a.localeCompare(b))).toEqual([
      s3Blob,
      `0x${'02'.repeat(16)}`
    ]);
    expect(s3.objects.size).toBe(0);
  });

  it('keeps blobs whose store fails so their rows survive for a retry', async () => {
    const failing: E2eeBlobStores = {
      forNewBlob: jest.fn(),
      forBlob: ({ storage }) => ({
        storage: storage === 's3' ? 's3' : 'mysql',
        location: null,
        putChunk: jest.fn(),
        getChunk: jest.fn(),
        deleteBlobs: async () => {
          if (storage === 's3') throw new Error('SlowDown');
        }
      })
    };

    const deleted = await deleteStoredE2eeBlobs(failing, [
      { blob_id: 's3-blob', chunk_count: 1, storage: 's3' },
      { blob_id: 'mysql-blob', chunk_count: 1, storage: 'mysql' }
    ]);

    expect(deleted).toEqual(['mysql-blob']);
  });
});
