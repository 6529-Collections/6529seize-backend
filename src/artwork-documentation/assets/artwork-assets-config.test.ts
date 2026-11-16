import { artworkArchiveBucket } from '@/artwork-documentation/assets/artwork-assets.config';

const KEYS = [
  'ARTWORK_DOCUMENTATION_S3_BUCKET',
  'ARTWORK_DOCUMENTATION_S3_REGION',
  'AWS_REGION',
  'AWS_ACCOUNT_ID'
] as const;

describe('artworkArchiveBucket', () => {
  const saved: Partial<Record<(typeof KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('prefers the explicitly configured bucket', () => {
    process.env.ARTWORK_DOCUMENTATION_S3_BUCKET = 'configured-bucket';
    expect(artworkArchiveBucket()).toBe('configured-bucket');
  });

  it('derives the bucket from the account and region', () => {
    process.env.ARTWORK_DOCUMENTATION_S3_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '111122223333';
    expect(artworkArchiveBucket()).toBe(
      '6529-artwork-documentation-111122223333-us-east-1'
    );
  });

  it.each([undefined, '', 'not-an-account'])(
    'is unavailable without a valid account id (%j)',
    (accountId) => {
      process.env.ARTWORK_DOCUMENTATION_S3_REGION = 'eu-west-1';
      if (accountId !== undefined) process.env.AWS_ACCOUNT_ID = accountId;
      expect(() => artworkArchiveBucket()).toThrow();
    }
  );

  it('is unavailable outside the release regions', () => {
    process.env.ARTWORK_DOCUMENTATION_S3_REGION = 'ap-south-1';
    process.env.AWS_ACCOUNT_ID = '111122223333';
    expect(() => artworkArchiveBucket()).toThrow();
  });
});
