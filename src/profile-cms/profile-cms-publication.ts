import { ProfileCmsPackageEntity } from '@/entities/IProfileCmsPackage';
import { CmsPackageV1 } from '@/profile-cms/protocol/v1';
import {
  ProfileCmsPublishSignatureRequest,
  ProfileCmsPublishSignatureVerificationResult
} from '@/profile-cms/profile-cms-signing';

/** A signed publish intent and recovery envelope, not proof of the current pointer. */
export function buildProfileCmsPublicationManifest(params: {
  entity: ProfileCmsPackageEntity;
  cmsPackage: CmsPackageV1;
  request: ProfileCmsPublishSignatureRequest;
  verification: ProfileCmsPublishSignatureVerificationResult;
  publishedAt: number;
}) {
  const { cmsPackage, request, verification, publishedAt } = params;
  const message = verification.typed_data.message;
  return {
    schema: '6529.cms.publication.v1' as const,
    package_uri: message.storageUri,
    package_hash: message.packageHash,
    payload_hash: message.payloadHash,
    profile_id: message.profileId,
    profile_handle: message.handle,
    package_id: message.packageId,
    package_db_id: message.draftId,
    version: message.version,
    primary_path: message.primaryPath,
    typed_data: {
      ...verification.typed_data,
      primaryType: 'ProfileCmsPublish' as const
    },
    signature: request.signature,
    signature_kind: request.is_safe_signature
      ? ('eip1271' as const)
      : ('eoa' as const),
    signer_address: verification.signer_address,
    package_envelope: {
      integrity: cmsPackage.integrity,
      signatures: cmsPackage.signatures,
      storage: cmsPackage.storage
    },
    // This is unsigned server metadata: the first publication attempt time.
    published_at: publishedAt
  };
}

export type ProfileCmsPublicationManifest = ReturnType<
  typeof buildProfileCmsPublicationManifest
>;
