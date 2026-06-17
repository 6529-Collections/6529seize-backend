import { CmsPackageV1 } from '@/profile-cms/protocol/v1';

export interface ProfileCmsStorageValidationResult {
  readonly valid: boolean;
  readonly canonical_receipt?: CmsPackageV1['storage'][number];
  readonly reason?: string;
}

export interface ProfileCmsStorageReceiptAdapter {
  readonly provider: 'ipfs' | 'arweave';
  validateCanonicalReceipt(params: {
    readonly receipt: CmsPackageV1['storage'][number];
    readonly packageHash: string;
  }): ProfileCmsStorageValidationResult;
}

export class ProfileCmsStorageReceiptVerifier {
  constructor(
    private readonly adapters: readonly ProfileCmsStorageReceiptAdapter[] = [
      new IpfsProfileCmsStorageReceiptAdapter(),
      new ArweaveProfileCmsStorageReceiptAdapter()
    ]
  ) {}

  validateForPublish(
    cmsPackage: CmsPackageV1
  ): ProfileCmsStorageValidationResult {
    const canonicalReceipts = cmsPackage.storage.filter(
      (receipt) => receipt.canonical
    );
    if (canonicalReceipts.length !== 1) {
      return invalid('canonical_decentralized_receipt_required');
    }
    const [receipt] = canonicalReceipts;
    const adapter = this.adapters.find(
      (candidate) => candidate.provider === receipt.provider
    );
    if (!adapter) {
      return invalid('canonical_receipt_provider_not_decentralized');
    }
    return adapter.validateCanonicalReceipt({
      receipt,
      packageHash: cmsPackage.integrity.package_hash
    });
  }
}

export class IpfsProfileCmsStorageReceiptAdapter implements ProfileCmsStorageReceiptAdapter {
  readonly provider = 'ipfs' as const;

  validateCanonicalReceipt({
    receipt,
    packageHash
  }: {
    readonly receipt: CmsPackageV1['storage'][number];
    readonly packageHash: string;
  }): ProfileCmsStorageValidationResult {
    if (receipt.content_hash !== packageHash) {
      return invalid('storage_content_hash_mismatch');
    }
    const cid = extractIpfsCid(receipt.uri);
    if (!cid) {
      return invalid('invalid_ipfs_uri');
    }
    if (receipt.provider_content_id && receipt.provider_content_id !== cid) {
      return invalid('ipfs_provider_content_id_mismatch');
    }
    return { valid: true, canonical_receipt: receipt };
  }
}

export class ArweaveProfileCmsStorageReceiptAdapter implements ProfileCmsStorageReceiptAdapter {
  readonly provider = 'arweave' as const;

  validateCanonicalReceipt({
    receipt,
    packageHash
  }: {
    readonly receipt: CmsPackageV1['storage'][number];
    readonly packageHash: string;
  }): ProfileCmsStorageValidationResult {
    if (receipt.content_hash !== packageHash) {
      return invalid('storage_content_hash_mismatch');
    }
    const transactionId = extractArweaveTransactionId(receipt.uri);
    if (!transactionId) {
      return invalid('invalid_arweave_uri');
    }
    if (
      receipt.provider_content_id &&
      receipt.provider_content_id !== transactionId
    ) {
      return invalid('arweave_provider_content_id_mismatch');
    }
    return { valid: true, canonical_receipt: receipt };
  }
}

export const profileCmsStorageReceiptVerifier =
  new ProfileCmsStorageReceiptVerifier();

function extractIpfsCid(uri: string): string | null {
  const match = /^ipfs:\/\/([^/?#]+)(?:[/?#].*)?$/.exec(uri);
  if (!match || !isLikelyIpfsCid(match[1])) {
    return null;
  }
  return match[1];
}

function extractArweaveTransactionId(uri: string): string | null {
  const nativeMatch = /^ar:\/\/([^/?#]+)(?:[/?#].*)?$/.exec(uri);
  if (nativeMatch && isLikelyArweaveTransactionId(nativeMatch[1])) {
    return nativeMatch[1];
  }
  return null;
}

function isLikelyIpfsCid(value: string): boolean {
  return /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,}|z[1-9A-HJ-NP-Za-km-z]{20,})$/.test(
    value
  );
}

function isLikelyArweaveTransactionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function invalid(reason: string): ProfileCmsStorageValidationResult {
  return { valid: false, reason };
}
