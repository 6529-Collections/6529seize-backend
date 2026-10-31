import {
  parseE2eeBlobMigrationRequest,
  runE2eeBlobMigrationScope
} from './e2ee-blob-migration-scope';
import { E2eeDb } from '@/e2ee/e2ee.db';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const STAGING_ENV = {
  NODE_ENV: 'development',
  E2EE_BLOB_S3_BUCKET: '6529-drop-media-ingest-987989283142',
  E2EE_BLOB_S3_PREFIX: 'staging/e2ee-blobs',
  E2EE_BLOB_S3_REGION: 'eu-west-1'
};

describe('parseE2eeBlobMigrationRequest', () => {
  it('is a dry run of 200 blobs at the configured location by default', () => {
    expect(
      parseE2eeBlobMigrationRequest(
        { schema_scope: 'e2ee-blobs-to-s3' },
        STAGING_ENV
      )
    ).toEqual({
      live: false,
      limit: 200,
      s3: {
        bucket: '6529-drop-media-ingest-987989283142',
        prefix: 'staging/e2ee-blobs',
        region: 'eu-west-1'
      }
    });
  });

  it('runs live only for live: true and accepts an explicit location', () => {
    expect(
      parseE2eeBlobMigrationRequest(
        {
          live: true,
          limit: 25,
          bucket: 'other-private-bucket',
          prefix: 'e2ee/staging',
          region: 'eu-west-1'
        },
        { NODE_ENV: 'development' }
      )
    ).toEqual({
      live: true,
      limit: 25,
      s3: {
        bucket: 'other-private-bucket',
        prefix: 'e2ee/staging',
        region: 'eu-west-1'
      }
    });
  });

  it.each([
    ['a non-boolean live flag', { live: 'true' }, STAGING_ENV],
    ['a limit above the maximum', { limit: 5000 }, STAGING_ENV],
    ['a fractional limit', { limit: 1.5 }, STAGING_ENV],
    ['a missing location', {}, { NODE_ENV: 'development' }],
    [
      'a production prefix in staging',
      { prefix: 'prod/e2ee-blobs' },
      STAGING_ENV
    ],
    [
      'a staging prefix in production',
      {},
      { ...STAGING_ENV, NODE_ENV: 'production' }
    ]
  ])('refuses %s', (_, event, env) => {
    expect(() =>
      parseE2eeBlobMigrationRequest(event as Record<string, unknown>, env)
    ).toThrow();
  });
});

describe('runE2eeBlobMigrationScope', () => {
  it('runs the migration against the parsed location', async () => {
    const s3 = new InMemoryE2eeBlobS3('6529-drop-media-ingest-987989283142');
    const db = {
      getBlobStorageInventory: jest.fn(async () => []),
      getMigratableBlobs: jest.fn(async () => []),
      getBlobChunkBytes: jest.fn(),
      switchBlobToS3: jest.fn()
    } as unknown as E2eeDb;
    const s3Client = jest.fn(() => s3);

    const report = await runE2eeBlobMigrationScope(
      { schema_scope: 'e2ee-blobs-to-s3' },
      { db, s3Client, env: STAGING_ENV }
    );

    expect(s3Client).toHaveBeenCalledWith('eu-west-1');
    expect(report).toMatchObject({
      mode: 'dry-run',
      examined: 0,
      migrated: 0,
      more: false
    });
  });
});
