import { ethers } from 'ethers';
import { canonicalizeCmsJson, hashCmsJson } from '@/api/cms/cms.hashing';
import { LegacySignatureForm } from '@/profile-cms/chain/profile-cms-archive';

export interface LegacySignatureCheck {
  readonly verified: boolean;
  readonly form: LegacySignatureForm | null;
  readonly signer: string | null;
}

/**
 * Checks a legacy CMS package's stored signature envelope, which 6529.io kept
 * without checking. The legacy API stores the envelope inside the package
 * JSON (`package_json.signature`), so `package_hash` covers the signature
 * itself and can't be what was signed. The signed message was never defined;
 * these EIP-191 personal-sign messages count, each over the package without
 * its signature:
 *
 * - `payload_hash`;
 * - the hash, or the canonical JSON, of the package with `package_hash` null
 *   and `signature` removed, set to null, or removed together with `storage`
 *   (signed before the upload).
 *
 * The signer must be the envelope's `signing_wallet` and one of the owner's
 * wallets at the freeze.
 */
export function checkLegacyCmsSignature(params: {
  readonly payloadHash: string;
  readonly packageJson: Record<string, unknown>;
  readonly signatureJson: unknown;
  readonly ownerWallets: readonly string[];
}): LegacySignatureCheck {
  const envelope = readEnvelope(params.signatureJson);
  if (!envelope) {
    return { verified: false, form: null, signer: null };
  }
  const wallets = new Set(
    params.ownerWallets.map((wallet) => wallet.toLowerCase())
  );
  if (!wallets.has(envelope.signingWallet)) {
    return { verified: false, form: null, signer: null };
  }
  for (const [form, message] of legacySignedMessages(params)) {
    const signer = recover(message, envelope.signature);
    if (signer === envelope.signingWallet) {
      return { verified: true, form, signer };
    }
  }
  return { verified: false, form: null, signer: null };
}

/** The messages a legacy signature may sign, in the order they are tried. */
export function legacySignedMessages(params: {
  readonly payloadHash: string;
  readonly packageJson: Record<string, unknown>;
}): readonly [LegacySignatureForm, () => string][] {
  const {
    signature: _signature,
    storage: _storage,
    ...unsignedUnstored
  } = params.packageJson;
  const { signature: _removed, ...unsigned } = params.packageJson;
  const preimages: Record<string, Record<string, unknown>> = {
    removed: { ...unsigned, package_hash: null },
    null: { ...params.packageJson, signature: null, package_hash: null },
    unstored: { ...unsignedUnstored, package_hash: null }
  };
  return [
    ['personal_sign_payload_hash', () => params.payloadHash],
    ['personal_sign_unsigned_hash', () => hashCmsJson(preimages.removed)],
    ['personal_sign_unsigned_hash_null', () => hashCmsJson(preimages.null)],
    [
      'personal_sign_unsigned_unstored_hash',
      () => hashCmsJson(preimages.unstored)
    ],
    [
      'personal_sign_unsigned_preimage',
      () => canonicalizeCmsJson(preimages.removed)
    ],
    [
      'personal_sign_unsigned_preimage_null',
      () => canonicalizeCmsJson(preimages.null)
    ],
    [
      'personal_sign_unsigned_unstored_preimage',
      () => canonicalizeCmsJson(preimages.unstored)
    ]
  ];
}

function readEnvelope(
  value: unknown
): { readonly signingWallet: string; readonly signature: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { signing_wallet: signingWallet, signature } = value as Record<
    string,
    unknown
  >;
  if (
    typeof signingWallet !== 'string' ||
    !/^0x[a-fA-F0-9]{40}$/.test(signingWallet) ||
    typeof signature !== 'string' ||
    !/^0x[a-fA-F0-9]+$/.test(signature)
  ) {
    return null;
  }
  return { signingWallet: signingWallet.toLowerCase(), signature };
}

function recover(message: () => string, signature: string): string | null {
  try {
    return ethers.verifyMessage(message(), signature).toLowerCase();
  } catch {
    return null;
  }
}
