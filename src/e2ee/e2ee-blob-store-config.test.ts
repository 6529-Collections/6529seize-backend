import {
  parseE2eeBlobS3Config,
  readE2eeBlobStoreSettings
} from '@/e2ee/e2ee-blob-store.config';

const STAGING_S3 = {
  NODE_ENV: 'development',
  E2EE_BLOB_STORE: 's3',
  E2EE_BLOB_S3_BUCKET: '6529-drop-media-ingest-987989283142',
  E2EE_BLOB_S3_PREFIX: 'staging/e2ee-blobs',
  E2EE_BLOB_S3_REGION: 'eu-west-1'
};

describe('readE2eeBlobStoreSettings', () => {
  it('defaults to MySQL with no S3 location', () => {
    expect(readE2eeBlobStoreSettings({})).toEqual({
      writeStorage: 'mysql',
      s3: null,
      problems: []
    });
    expect(
      readE2eeBlobStoreSettings({ E2EE_BLOB_STORE: ' MySQL ' }).writeStorage
    ).toBe('mysql');
  });

  it('reads a complete S3 configuration', () => {
    expect(readE2eeBlobStoreSettings(STAGING_S3)).toEqual({
      writeStorage: 's3',
      s3: {
        bucket: '6529-drop-media-ingest-987989283142',
        prefix: 'staging/e2ee-blobs',
        region: 'eu-west-1'
      },
      problems: []
    });
  });

  it('strips a trailing slash and falls back to AWS_REGION, then eu-west-1', () => {
    const base = {
      ...STAGING_S3,
      E2EE_BLOB_S3_PREFIX: 'staging/e2ee-blobs/',
      E2EE_BLOB_S3_REGION: undefined
    };
    expect(
      readE2eeBlobStoreSettings({ ...base, AWS_REGION: 'us-east-1' }).s3
    ).toEqual({
      bucket: '6529-drop-media-ingest-987989283142',
      prefix: 'staging/e2ee-blobs',
      region: 'us-east-1'
    });
    expect(readE2eeBlobStoreSettings(base).s3?.region).toBe('eu-west-1');
  });

  it.each([
    ['the bucket is missing', { E2EE_BLOB_S3_BUCKET: undefined }],
    ['the prefix is missing', { E2EE_BLOB_S3_PREFIX: '  ' }],
    ['the bucket name is invalid', { E2EE_BLOB_S3_BUCKET: 'Bad_Bucket' }],
    ['the prefix starts with a slash', { E2EE_BLOB_S3_PREFIX: '/staging/x' }],
    ['the prefix climbs', { E2EE_BLOB_S3_PREFIX: 'staging/../prod' }],
    ['the prefix has an empty segment', { E2EE_BLOB_S3_PREFIX: 'staging//x' }],
    [
      'the prefix sits in an expiring ingest prefix',
      { E2EE_BLOB_S3_PREFIX: 'staging/drop-media-ingest/e2ee' }
    ],
    [
      'the prefix names another environment',
      { E2EE_BLOB_S3_PREFIX: 'prod/e2ee-blobs' }
    ],
    ['the region is invalid', { E2EE_BLOB_S3_REGION: 'europe' }]
  ])('fails closed for new uploads when %s', (_, override) => {
    const settings = readE2eeBlobStoreSettings({ ...STAGING_S3, ...override });
    expect(settings.writeStorage).toBeNull();
    expect(settings.s3).toBeNull();
    expect(settings.problems.length).toBeGreaterThan(0);
  });

  it('fails closed for an unknown store instead of using MySQL', () => {
    const settings = readE2eeBlobStoreSettings({ E2EE_BLOB_STORE: 'ipfs' });
    expect(settings.writeStorage).toBeNull();
    expect(settings.problems).toEqual([
      'E2EE_BLOB_STORE must be "mysql" or "s3"'
    ]);
  });

  it('keeps MySQL uploads working but reports a broken S3 location', () => {
    const settings = readE2eeBlobStoreSettings({
      ...STAGING_S3,
      E2EE_BLOB_STORE: 'mysql',
      E2EE_BLOB_S3_BUCKET: undefined
    });
    expect(settings.writeStorage).toBe('mysql');
    expect(settings.s3).toBeNull();
    expect(settings.problems).toEqual(['E2EE_BLOB_S3_BUCKET is not set']);
  });

  it('requires the production stage segment in production', () => {
    const production = { ...STAGING_S3, NODE_ENV: 'production' };
    expect(readE2eeBlobStoreSettings(production).writeStorage).toBeNull();
    expect(
      readE2eeBlobStoreSettings({
        ...production,
        E2EE_BLOB_S3_PREFIX: 'prod/e2ee-blobs'
      }).s3?.prefix
    ).toBe('prod/e2ee-blobs');
  });

  it('never echoes configured values in problems', () => {
    const settings = readE2eeBlobStoreSettings({
      ...STAGING_S3,
      E2EE_BLOB_S3_BUCKET: 'Secret_Looking_Value'
    });
    expect(settings.problems.join(' ')).not.toContain('Secret_Looking_Value');
  });
});

describe('parseE2eeBlobS3Config', () => {
  it('accepts an e2ee/<stage> layout too', () => {
    expect(
      parseE2eeBlobS3Config({
        bucket: 'private-bucket',
        prefix: 'e2ee/staging',
        nodeEnv: 'development'
      }).config
    ).toEqual({
      bucket: 'private-bucket',
      prefix: 'e2ee/staging',
      region: 'eu-west-1'
    });
  });
});
