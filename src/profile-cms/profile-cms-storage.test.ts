import { ProfileCmsStorageReceiptVerifier } from '@/profile-cms/profile-cms-storage';
import {
  createFixtureProfileCmsStorageReceipt,
  createValidProfileCmsPackage,
  PROFILE_CMS_FIXTURE_ZERO_HASH
} from '@/tests/fixtures/profile-cms-package.fixture';

describe('profile CMS storage receipt verifier', () => {
  const verifier = new ProfileCmsStorageReceiptVerifier();

  it('accepts a canonical IPFS receipt whose content hash matches the package hash', () => {
    const cmsPackage = createValidProfileCmsPackage();

    expect(verifier.validateForPublish(cmsPackage)).toMatchObject({
      valid: true,
      canonical_receipt: cmsPackage.storage[0]
    });
  });

  it('accepts a canonical Arweave receipt whose content hash matches the package hash', () => {
    const cmsPackage = createValidProfileCmsPackage();
    const arweaveId = 'a'.repeat(43);

    expect(
      verifier.validateForPublish({
        ...cmsPackage,
        storage: [
          {
            provider: 'arweave',
            uri: `ar://${arweaveId}`,
            content_hash: cmsPackage.integrity.package_hash,
            provider_content_id: arweaveId,
            canonical: true,
            recorded_at: '2026-06-17T00:00:00.000Z'
          }
        ]
      })
    ).toMatchObject({ valid: true });
  });

  it('rejects Arweave gateway URLs as canonical publish receipts', () => {
    const cmsPackage = createValidProfileCmsPackage();
    const arweaveId = 'a'.repeat(43);

    expect(
      verifier.validateForPublish({
        ...cmsPackage,
        storage: [
          {
            provider: 'arweave',
            uri: `https://arweave.net/${arweaveId}`,
            content_hash: cmsPackage.integrity.package_hash,
            provider_content_id: arweaveId,
            canonical: true,
            recorded_at: '2026-06-17T00:00:00.000Z'
          }
        ]
      })
    ).toMatchObject({
      valid: false,
      reason: 'invalid_arweave_uri'
    });
  });

  it('rejects fixture storage for production publish', () => {
    const cmsPackage = createValidProfileCmsPackage();

    expect(
      verifier.validateForPublish({
        ...cmsPackage,
        storage: [createFixtureProfileCmsStorageReceipt()]
      })
    ).toMatchObject({
      valid: false,
      reason: 'canonical_receipt_provider_not_decentralized'
    });
  });

  it('rejects S3-only storage for production publish', () => {
    const cmsPackage = createValidProfileCmsPackage();

    expect(
      verifier.validateForPublish({
        ...cmsPackage,
        storage: [
          {
            provider: 's3',
            uri: 'https://s3.example.invalid/package.json',
            content_hash: cmsPackage.integrity.package_hash,
            canonical: true,
            recorded_at: '2026-06-17T00:00:00.000Z'
          }
        ]
      })
    ).toMatchObject({
      valid: false,
      reason: 'canonical_receipt_provider_not_decentralized'
    });
  });

  it('rejects receipt content hash mismatches', () => {
    const cmsPackage = createValidProfileCmsPackage();

    expect(
      verifier.validateForPublish({
        ...cmsPackage,
        storage: [
          {
            ...cmsPackage.storage[0],
            content_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
          }
        ]
      })
    ).toMatchObject({
      valid: false,
      reason: 'storage_content_hash_mismatch'
    });
  });
});
