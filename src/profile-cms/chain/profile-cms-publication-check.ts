import { z } from 'zod';
import {
  cmsCidMatchesBytes,
  cmsHashFromCid
} from '@/profile-cms/chain/profile-cms-cid';
import { ProfileDocCmsPrimary } from '@/profile-cms/chain/profile-doc-cms';
import {
  defaultEip1271SignatureVerifier,
  Eip1271SignatureVerifier,
  PROFILE_CMS_PUBLISH_EIP712_TYPES,
  ProfileCmsPublishTypedData,
  ProfileCmsPublishTypedDataMessage,
  verifyProfileCmsPublishSignature
} from '@/profile-cms/profile-cms-signing';
import {
  canonicalizeJson,
  CmsPackageV1,
  cmsPackageSchema,
  CmsStorageReceiptV1,
  CmsValidationResultV1,
  computeCmsPackageHash,
  integritySchema,
  signatureEnvelopeSchema,
  storageReceiptSchema,
  toPackageHashInput,
  validateCmsPackageV1
} from '@/profile-cms/protocol/v1';
import { profileCmsStorageReceiptVerifier } from '@/profile-cms/profile-cms-storage';

const boundedString = z.string().min(1).max(2048);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const unsignedInteger = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
]);

/** `6529.cms.publication.v1`, as the backend writes it and the frontend's recovery reads it. */
const publicationSchema = z
  .object({
    schema: z.literal('6529.cms.publication.v1'),
    package_uri: boundedString,
    package_hash: hash,
    payload_hash: hash,
    profile_id: boundedString,
    profile_handle: boundedString,
    package_id: boundedString,
    package_db_id: boundedString,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    primary_path: boundedString,
    typed_data: z
      .object({
        domain: z
          .object({
            name: z.literal('6529 Profile CMS'),
            version: z.literal('1'),
            chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            verifyingContract: address.optional()
          })
          .strict(),
        types: z.record(
          z.array(
            z.object({ name: boundedString, type: boundedString }).strict()
          )
        ),
        primaryType: z.literal('ProfileCmsPublish'),
        message: z
          .object({
            action: z.literal('publish'),
            profileId: boundedString,
            handle: boundedString,
            packageId: boundedString,
            version: unsignedInteger,
            draftId: boundedString,
            payloadHash: hash,
            packageHash: hash,
            primaryPath: boundedString,
            storageProvider: z.enum(['arweave', 'ipfs']),
            storageUri: boundedString,
            storageContentHash: hash,
            deadline: unsignedInteger
          })
          .strict()
      })
      .strict(),
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]+$/)
      .max(131074)
      .refine((value) => value.length % 2 === 0),
    signature_kind: z.enum(['eoa', 'eip1271']),
    signer_address: address,
    package_envelope: z
      .object({
        integrity: integritySchema,
        signatures: z.array(signatureEnvelopeSchema).min(1),
        storage: z.array(storageReceiptSchema).min(1)
      })
      .strict(),
    published_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

export type ProfileCmsPublication = z.infer<typeof publicationSchema>;

export interface CheckedProfileCmsPublication {
  readonly publication: ProfileCmsPublication;
  readonly publication_cid: string;
  readonly package_cid: string;
  /** The content core with the publication's envelope: what the site serves. */
  readonly cms_package: CmsPackageV1;
  readonly canonical_receipt: CmsStorageReceiptV1;
  readonly validation_result: CmsValidationResultV1;
  readonly signer_address: string;
  /** Domain, types and message, as 6529.io stores typed data on pointer events. */
  readonly typed_data: ProfileCmsPublishTypedData;
  readonly typed_data_hash: string;
  readonly deadline: number;
}

export type ProfileCmsPublicationCheck =
  | { readonly ok: true; readonly checked: CheckedProfileCmsPublication }
  | { readonly ok: false; readonly reason: string };

export interface ProfileCmsPublicationCheckInput {
  readonly primary: ProfileDocCmsPrimary;
  readonly publicationBytes: Buffer | null;
  readonly packageBytes: Buffer | null;
  /** 6529.io's profile id of the principal whose document names the site. */
  readonly profileId: string;
  /** The principal's wallets at the height the pointer was set, lower case. */
  readonly wallets: readonly string[];
  /**
   * True when the index already holds this publication as published: its
   * signer was checked against the profile when it was first published, on
   * 6529.io before the switch or on the chain after it.
   */
  readonly signerAccepted?: boolean;
  /** The time the pointer was set; stamps the validation result. */
  readonly checkedAtMs: number;
}

/**
 * Checks the site a ProfileDoc's `cms.primary.*` keys name the way a reader must before serving a
 * site: both files hash to their CIDs, the publication's EIP-712 signature
 * verifies and binds the package, the signer belonged to the person, and the
 * package with the publication's envelope passes production validation.
 * The handle check stays at read time, as on 6529.io today.
 */
export async function checkProfileCmsPublication(
  input: ProfileCmsPublicationCheckInput,
  safeVerifier: Eip1271SignatureVerifier = defaultEip1271SignatureVerifier
): Promise<ProfileCmsPublicationCheck> {
  const files = checkFiles(input);
  if (!files.ok) {
    return files;
  }
  const { publication, core } = files;
  const bindings = checkBindings(publication, input);
  if (bindings) {
    return { ok: false, reason: bindings };
  }
  const cmsPackage = overlayEnvelope(core, publication);
  if (!cmsPackage) {
    return { ok: false, reason: 'package_not_cms_v1' };
  }
  if (computeCmsPackageHash(cmsPackage) !== publication.package_hash) {
    return { ok: false, reason: 'package_hash_mismatch' };
  }
  const signature = await verifySignature(publication, safeVerifier);
  if (!signature.ok) {
    return signature;
  }
  if (!input.signerAccepted && !input.wallets.includes(signature.signer)) {
    return { ok: false, reason: 'signer_not_in_profile' };
  }
  const validation = validateCmsPackageV1(cmsPackage, {
    allowFixtureSignatures: false,
    allowFixtureStorage: false,
    enforceHashes: true,
    checkedAt: new Date(input.checkedAtMs).toISOString()
  });
  if (!validation.valid) {
    return { ok: false, reason: 'package_not_production_valid' };
  }
  const storage =
    profileCmsStorageReceiptVerifier.validateForPublish(cmsPackage);
  if (!storage.valid || !storage.canonical_receipt) {
    return {
      ok: false,
      reason: `storage_${storage.reason ?? 'receipt_invalid'}`
    };
  }
  return {
    ok: true,
    checked: {
      publication,
      publication_cid: input.primary.publication,
      package_cid: input.primary.package,
      cms_package: cmsPackage,
      canonical_receipt: storage.canonical_receipt,
      validation_result: validation,
      signer_address: signature.signer,
      typed_data: signature.typedData,
      typed_data_hash: signature.typedDataHash,
      deadline: Number(publication.typed_data.message.deadline)
    }
  };
}

function checkFiles(
  input: ProfileCmsPublicationCheckInput
):
  | { ok: true; publication: ProfileCmsPublication; core: unknown }
  | { ok: false; reason: string } {
  const { primary, publicationBytes, packageBytes } = input;
  if (!publicationBytes) {
    return { ok: false, reason: 'publication_not_found' };
  }
  if (!packageBytes) {
    return { ok: false, reason: 'package_not_found' };
  }
  if (!cmsCidMatchesBytes(primary.publication, publicationBytes)) {
    return { ok: false, reason: 'publication_cid_mismatch' };
  }
  if (!cmsCidMatchesBytes(primary.package, packageBytes)) {
    return { ok: false, reason: 'package_cid_mismatch' };
  }
  const publication = publicationSchema.safeParse(parseJson(publicationBytes));
  if (!publication.success) {
    return { ok: false, reason: 'publication_schema_invalid' };
  }
  const core = parseJson(packageBytes);
  if (
    core === undefined ||
    canonicalizeJsonOrNull(core) !== packageBytes.toString('utf8')
  ) {
    return { ok: false, reason: 'package_not_canonical' };
  }
  return { ok: true, publication: publication.data, core };
}

function checkBindings(
  publication: ProfileCmsPublication,
  input: ProfileCmsPublicationCheckInput
): string | null {
  const message = publication.typed_data.message;
  if (publication.package_hash !== cmsHashFromCid(input.primary.package)) {
    return 'package_cid_not_signed';
  }
  if (publication.profile_id !== input.profileId) {
    return 'publication_for_another_profile';
  }
  if (
    canonicalizeJsonOrNull(publication.typed_data.types) !==
    canonicalizeJsonOrNull(PROFILE_CMS_PUBLISH_EIP712_TYPES)
  ) {
    return 'publication_types_mismatch';
  }
  const bound =
    message.profileId === publication.profile_id &&
    message.handle === publication.profile_handle &&
    message.packageId === publication.package_id &&
    String(message.version) === String(publication.version) &&
    message.draftId === publication.package_db_id &&
    message.payloadHash === publication.payload_hash &&
    message.packageHash === publication.package_hash &&
    message.primaryPath === publication.primary_path &&
    message.storageUri === publication.package_uri &&
    message.storageContentHash === publication.package_hash &&
    publication.package_envelope.integrity.package_hash ===
      publication.package_hash &&
    publication.package_envelope.integrity.payload_hash ===
      publication.payload_hash;
  return bound ? null : 'publication_bindings_mismatch';
}

function overlayEnvelope(
  core: unknown,
  publication: ProfileCmsPublication
): CmsPackageV1 | null {
  if (typeof core !== 'object' || core === null || Array.isArray(core)) {
    return null;
  }
  const parsed = cmsPackageSchema.safeParse({
    ...core,
    integrity: publication.package_envelope.integrity,
    signatures: publication.package_envelope.signatures,
    storage: publication.package_envelope.storage
  });
  if (!parsed.success) {
    return null;
  }
  // The core must be exactly the package-hash preimage, nothing more.
  return canonicalizeJsonOrNull(toPackageHashInput(parsed.data)) ===
    canonicalizeJsonOrNull(core)
    ? parsed.data
    : null;
}

async function verifySignature(
  publication: ProfileCmsPublication,
  safeVerifier: Eip1271SignatureVerifier
): Promise<
  | {
      ok: true;
      signer: string;
      typedData: ProfileCmsPublishTypedData;
      typedDataHash: string;
    }
  | { ok: false; reason: string }
> {
  const { domain, message } = publication.typed_data;
  const typedMessage: ProfileCmsPublishTypedDataMessage = {
    ...message,
    version: Number(message.version),
    deadline: Number(message.deadline)
  };
  const result = await verifyProfileCmsPublishSignature(
    {
      request: {
        signer_address: publication.signer_address,
        signature: publication.signature,
        chain_id: domain.chainId,
        deadline: typedMessage.deadline,
        is_safe_signature: publication.signature_kind === 'eip1271',
        verifying_contract: domain.verifyingContract ?? null
      },
      message: typedMessage
    },
    safeVerifier
  );
  if (!result.valid || !result.signer_address) {
    return { ok: false, reason: `signature_${result.reason ?? 'invalid'}` };
  }
  return {
    ok: true,
    signer: result.signer_address.toLowerCase(),
    typedData: result.typed_data,
    typedDataHash: result.typed_data_hash
  };
}

const RETRYABLE_REASONS = new Set([
  'publication_not_found',
  'package_not_found',
  'signature_eip1271_verification_failed'
]);

/**
 * A reason that may pass on its own: a file not in the document store yet,
 * or a Safe check that failed on the network. The follower retries these
 * before it records the site as refused.
 */
export function isRetryablePublicationReason(reason: string): boolean {
  return RETRYABLE_REASONS.has(reason);
}

/** The canonical receipt a reader can fetch the publication from by CID. */
export function publicationRecoveryReceipt(
  publicationCid: string,
  publicationHash: string,
  recordedAtMs: number
): CmsStorageReceiptV1 {
  return {
    provider: 'ipfs',
    uri: `ipfs://${publicationCid}`,
    content_hash: publicationHash,
    provider_content_id: publicationCid,
    canonical: true,
    recorded_at: new Date(recordedAtMs).toISOString()
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

function canonicalizeJsonOrNull(value: unknown): string | null {
  try {
    return canonicalizeJson(value);
  } catch {
    return null;
  }
}
