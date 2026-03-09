import {
  parseS3UploaderJob,
  S3UploaderCollectionType,
  S3UploaderImageVariant,
  S3UploaderJobType
} from '@/s3Uploader/s3-uploader.jobs';

describe('S3 uploader jobs', () => {
  const basePayload = {
    reason: 'discover',
    collectionType: S3UploaderCollectionType.NFT,
    contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
    tokenId: 466,
    jobType: S3UploaderJobType.IMAGE,
    variants: [S3UploaderImageVariant.ORIGINAL]
  };

  it('parses payload without version for backwards compatibility', () => {
    const result = parseS3UploaderJob(JSON.stringify(basePayload));
    expect(result).toEqual(basePayload);
  });

  it('parses payload with version = 1', () => {
    const withVersion = { ...basePayload, version: 1 };
    const result = parseS3UploaderJob(JSON.stringify(withVersion));
    expect(result).toEqual(withVersion);
  });

  it('rejects payload with unsupported reason', () => {
    const invalidReason = { ...basePayload, reason: 'manual' };
    const result = parseS3UploaderJob(JSON.stringify(invalidReason));
    expect(result).toBeNull();
  });

  it('rejects payload with unsupported version', () => {
    const invalidVersion = { ...basePayload, version: 2 };
    const result = parseS3UploaderJob(JSON.stringify(invalidVersion));
    expect(result).toBeNull();
  });
});
