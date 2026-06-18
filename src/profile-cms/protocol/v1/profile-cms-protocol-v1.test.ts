import {
  createFixtureProfileCmsSignature,
  createFixtureProfileCmsStorageReceipt,
  createValidProfileCmsPackage,
  PROFILE_CMS_FIXTURE_ZERO_HASH
} from '@/tests/fixtures/profile-cms-package.fixture';

import {
  canonicalizeJson,
  CmsPackageV1,
  computeCmsPackageHash,
  computeCmsPayloadHash,
  validateCmsPackageV1
} from './index';

const EXPECTED_CANONICAL_JSON = '{"a":"x","z":[3,{"a":1,"b":2},0]}';
const EXPECTED_PAYLOAD_HASH =
  'sha256:84388f74367905ec77d223328fe1f8da8533b345ac7556f52c9c85295c93c6ac';
const EXPECTED_PACKAGE_HASH =
  'sha256:a4ee9e0d66880209e51fb1b45d80aea3a1276ec436a944ecb873048cfe9e1e03';

describe('CMS protocol V1 backend parity vectors', () => {
  it('canonicalizes JSON with sorted object keys and JSON number semantics', () => {
    expect(canonicalizeJson({ z: [3, { b: 2, a: 1 }, -0], a: 'x' })).toBe(
      EXPECTED_CANONICAL_JSON
    );
  });

  it('computes stable payload and package hash vectors', () => {
    const cmsPackage = createValidProfileCmsPackage();

    expect(computeCmsPayloadHash(cmsPackage.payload)).toBe(
      EXPECTED_PAYLOAD_HASH
    );
    expect(computeCmsPackageHash(cmsPackage)).toBe(EXPECTED_PACKAGE_HASH);
    expect(cmsPackage.integrity.payload_hash).toBe(EXPECTED_PAYLOAD_HASH);
    expect(cmsPackage.integrity.package_hash).toBe(EXPECTED_PACKAGE_HASH);
  });

  it('excludes package_hash, signatures, and storage from package hash input', () => {
    const cmsPackage = createValidProfileCmsPackage();
    const fixtureVariant: CmsPackageV1 = {
      ...cmsPackage,
      integrity: {
        ...cmsPackage.integrity,
        package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
      },
      signatures: [createFixtureProfileCmsSignature()],
      storage: [createFixtureProfileCmsStorageReceipt()]
    };

    expect(computeCmsPackageHash(fixtureVariant)).toBe(EXPECTED_PACKAGE_HASH);
  });

  it('rejects fixture signatures and storage for production publish validation', () => {
    const fixturePackage: CmsPackageV1 = {
      ...createValidProfileCmsPackage(),
      signatures: [createFixtureProfileCmsSignature()],
      storage: [createFixtureProfileCmsStorageReceipt()]
    };

    const result = validateCmsPackageV1(fixturePackage, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true,
      checkedAt: '2026-06-17T00:00:00.000Z'
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues
        .map((issue) => issue.code)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual([
      'signature.fixture_not_allowed',
      'storage.decentralized_receipt_required',
      'storage.fixture_not_allowed'
    ]);
  });
});
