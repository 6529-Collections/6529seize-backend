import { Wallet, verifyTypedData, TypedDataEncoder } from 'ethers';
import { createHash } from 'node:crypto';
import { buildProfileCmsPublicationManifest } from './profile-cms-publication';
import { buildProfileCmsPublishTypedData } from './profile-cms-signing';
import {
  canonicalizeJson,
  toPackageHashInput,
  validateCmsPackageV1,
  CmsPackageV1,
  withComputedCmsHashes
} from './protocol/v1';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';
import { ProfileCmsPackageEntity } from '@/entities/IProfileCmsPackage';

it.each([false, true])(
  'reconstructs and verifies manifest and core bytes (imported handle casing: %s)',
  async (mixedCase) => {
    const wallet = Wallet.createRandom();
    let cmsPackage = createValidProfileCmsPackage({
      profileId: 'profile',
      handle: mixedCase ? 'MIXEDCASE' : 'MixedCase'
    });
    cmsPackage = withComputedCmsHashes({
      ...cmsPackage,
      profile: { ...cmsPackage.profile, primary_wallet: wallet.address }
    });
    const bodyBytes = Buffer.from(
      canonicalizeJson(toPackageHashInput(cmsPackage))
    );
    const packageHash = `sha256:${createHash('sha256').update(bodyBytes).digest('hex')}`;
    const receipt = {
      provider: 'arweave' as const,
      uri: `ar://${'a'.repeat(43)}`,
      content_hash: packageHash,
      canonical: true,
      recorded_at: '2026-09-10T00:00:00.000Z'
    };
    const message = {
      action: 'publish' as const,
      profileId: 'profile',
      handle: 'MixedCase',
      packageId: cmsPackage.package_id,
      version: 2,
      draftId: 'draft',
      payloadHash: cmsPackage.integrity.payload_hash,
      packageHash,
      primaryPath: '/MixedCase/index.html',
      storageProvider: receipt.provider,
      storageUri: receipt.uri,
      storageContentHash: packageHash,
      deadline: 1000
    };
    const typedData = buildProfileCmsPublishTypedData({
      request: {
        signer_address: wallet.address,
        signature: '',
        chain_id: 1,
        deadline: 1000
      },
      message
    });
    const signature = await wallet.signTypedData(
      typedData.domain,
      typedData.types,
      message
    );
    const request = {
      signer_address: wallet.address,
      signature,
      chain_id: 1,
      deadline: 1000
    };
    const typedDataHash = TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      message
    );
    cmsPackage = {
      ...cmsPackage,
      signatures: [
        {
          type: 'eip712',
          signer: wallet.address,
          signature,
          signed_at: '2026-09-10T00:00:00.000Z',
          domain: { ...typedData.domain, typed_data_hash: typedDataHash }
        }
      ],
      storage: [receipt]
    };
    const manifest = buildProfileCmsPublicationManifest({
      entity: { profile_id: 'profile' } as ProfileCmsPackageEntity,
      cmsPackage,
      request,
      verification: {
        valid: true,
        signer_address: wallet.address,
        typed_data: typedData,
        typed_data_hash: typedDataHash
      },
      publishedAt: 2000
    });
    const recovered = {
      ...JSON.parse(bodyBytes.toString()),
      ...manifest.package_envelope
    } as CmsPackageV1;
    expect(
      validateCmsPackageV1(recovered, {
        enforceHashes: true,
        allowFixtureStorage: false,
        allowFixtureSignatures: false
      }).valid
    ).toBe(true);
    expect(
      verifyTypedData(
        manifest.typed_data.domain,
        manifest.typed_data.types,
        manifest.typed_data.message,
        manifest.signature
      )
    ).toBe(wallet.address);
    expect(manifest.typed_data.message.deadline).toBe(1000); // Historical proofs remain verifiable after expiry.
    expect(JSON.parse(bodyBytes.toString())).not.toHaveProperty('signatures');
    expect(recovered.integrity.package_hash).toBe(packageHash);
  }
);
