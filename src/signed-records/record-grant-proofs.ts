import { ethers } from 'ethers';
import * as Joi from 'joi';
import {
  computeAppDeviceGrantId,
  isAppDeviceGrantMessage,
  parseAppDeviceGrantMessage,
  recoversToAppGrantWallet
} from '@/api/device-signing/app-device-grant';
import { computeDeviceGrantId } from '@/api/device-signing/device-grant-message';
import {
  hashWalletSignatureMessage,
  recoverWalletMessageSigner
} from '@/api/wallet-signatures/structured-wallet-signatures';
import { parseSiweWebAuthMessage } from '@/api/wallet-signatures/siwe-wallet-auth';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import type { RecordGrantProof } from './record-event';
import type { RecordGrantSource, VerifiedGrant } from './record-verify';

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x([0-9a-f]{2})+$/;
// device_grants keeps the message and the signature in MySQL text columns.
const TEXT_COLUMN_MAX = 65_535;

export const RecordGrantProofSchema: Joi.ObjectSchema<RecordGrantProof> =
  Joi.object<RecordGrantProof>({
    id: Joi.string().pattern(HEX32).required(),
    message: Joi.string().min(1).max(TEXT_COLUMN_MAX).required(),
    wallet_signature: Joi.string()
      .pattern(SIGNATURE)
      .max(TEXT_COLUMN_MAX)
      .required(),
    chain_id: Joi.number().integer().strict().min(1).required(),
    wallet: Joi.string().pattern(ADDRESS).required(),
    device_key: Joi.string().pattern(HEX32).required(),
    scopes: Joi.array().items(Joi.string().max(16)).max(8).required(),
    domain: Joi.string().max(255).allow('').required(),
    expires_at: Joi.number().integer().strict().min(0).required(),
    revoked_at: Joi.number().integer().strict().min(0).allow(null).required()
  })
    .required()
    .unknown(false);

export type GrantProofResult =
  | { readonly ok: true; readonly grant: VerifiedGrant }
  | { readonly ok: false; readonly reason: string };

interface GrantTerms {
  readonly id: string;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly scopes: readonly string[];
  readonly expiresAtMs: number;
  // Whether the signature recovers (ECDSA) to the wallet.
  readonly eoa: boolean;
  // What a contract wallet signed (EIP-1271), and on which chain.
  readonly signedHash: string;
  readonly chainId: number;
}

/** An app grant (6529 Mobile and Desktop): EIP-712 typed data on chain 1. */
function appGrantTerms(proof: RecordGrantProof): GrantTerms | string {
  const parsed = parseAppDeviceGrantMessage(proof.message);
  if (!parsed) {
    return 'app grant message does not parse';
  }
  const id = computeAppDeviceGrantId(parsed.message);
  return {
    id,
    wallet: parsed.grant.wallet,
    deviceKey: parsed.grant.device_key,
    scopes: parsed.grant.scopes,
    expiresAtMs: parsed.grant.expires_at * 1000,
    eoa: recoversToAppGrantWallet(parsed.message, proof.wallet_signature),
    signedHash: id,
    chainId: 1
  };
}

/** A website sign-in grant: a SIWE message (EIP-191) on its own chain. */
function loginGrantTerms(proof: RecordGrantProof): GrantTerms | string {
  const parsed = parseSiweWebAuthMessage(proof.message);
  if (!parsed?.deviceGrant) {
    return 'sign-in message carries no device grant';
  }
  const wallet = parsed.address.toLowerCase();
  return {
    id: computeDeviceGrantId(proof.message),
    wallet,
    deviceKey: parsed.deviceGrant.deviceKey,
    scopes: parsed.deviceGrant.scopes,
    expiresAtMs: parsed.deviceGrant.expiresAtSeconds * 1000,
    eoa:
      recoverWalletMessageSigner(proof.message, proof.wallet_signature) ===
      wallet,
    signedHash: hashWalletSignatureMessage(proof.message),
    chainId: parsed.chainId
  };
}

/**
 * EIP-1271 against Ethereum state: whether the contract wallet accepts the
 * signature over the hash. Throws when the chain cannot be read, so a
 * rebuild stops instead of dropping records.
 */
export interface ContractWalletSignatureCheck {
  isValidSignature(args: {
    readonly chainId: number;
    readonly wallet: string;
    readonly hash: string;
    readonly signature: string;
  }): Promise<boolean>;
}

const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const EIP1271_ABI = [
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'
];

/** The check through the shared Ethereum RPC, an allowed rebuild source. */
export const ethereumContractWalletCheck: ContractWalletSignatureCheck = {
  async isValidSignature({ chainId, wallet, hash, signature }) {
    const provider = getEthereumRpcProvider(chainId);
    const address = ethers.getAddress(wallet);
    const code = await provider.getCode(address);
    if (!code || code === '0x') {
      return false;
    }
    try {
      const result = await new ethers.Contract(
        address,
        EIP1271_ABI,
        provider
      ).isValidSignature(hash, signature);
      return String(result).toLowerCase() === EIP1271_MAGIC_VALUE;
    } catch (error) {
      // A revert is the wallet's answer; any other error is the chain's.
      if (ethers.isError(error, 'CALL_EXCEPTION')) {
        return false;
      }
      throw error;
    }
  }
};

type CheckedTerms =
  | {
      readonly ok: true;
      readonly terms: GrantTerms;
      readonly proof: RecordGrantProof;
    }
  | { readonly ok: false; readonly reason: string };

const SIGNATURE_MISMATCH =
  'the wallet signature does not recover to the grant wallet';

// Recovering a signature is the slow part of a replay, and every entry of
// one device repeats its grant proof: results are kept per exact proof.
const CACHE_LIMIT = 10_000;
const termsCache = new Map<string, CheckedTerms>();

/** Everything a proof says, checked against what its wallet signed. */
function checkProofTerms(value: unknown): CheckedTerms {
  const { error, value: proof } = RecordGrantProofSchema.validate(value);
  if (error) {
    return { ok: false, reason: `malformed grant proof (${error.message})` };
  }
  const cacheKey = JSON.stringify(proof);
  const cached = termsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const checked = checkTerms(proof);
  if (termsCache.size >= CACHE_LIMIT) {
    termsCache.clear();
  }
  termsCache.set(cacheKey, checked);
  return checked;
}

function checkTerms(proof: RecordGrantProof): CheckedTerms {
  const terms = isAppDeviceGrantMessage(proof.message)
    ? appGrantTerms(proof)
    : loginGrantTerms(proof);
  if (typeof terms === 'string') {
    return { ok: false, reason: terms };
  }
  if (
    terms.id !== proof.id ||
    terms.wallet !== proof.wallet ||
    terms.deviceKey !== proof.device_key ||
    terms.scopes.join(',') !== proof.scopes.join(',') ||
    terms.expiresAtMs !== proof.expires_at
  ) {
    return {
      ok: false,
      reason: 'grant proof fields differ from the signed grant'
    };
  }
  return { ok: true, terms, proof };
}

function grantOf(proof: RecordGrantProof): VerifiedGrant {
  return {
    id: proof.id,
    wallet: proof.wallet,
    deviceKey: proof.device_key,
    scopes: [...proof.scopes],
    expiresAt: proof.expires_at,
    revokedAt: proof.revoked_at
  };
}

/**
 * Checks a grant proof on its own, as relays do: the message parses as a
 * grant this server issues, the id is that message's hash, the wallet
 * signature recovers to the wallet, and the stored key, scopes and expiry
 * are the signed ones. EOA signatures only: a contract wallet's grant needs
 * Ethereum state, through verifyGrantProofWithChain. The revocation time is
 * the one 6529.io recorded with the proof; it is not wallet-signed.
 */
export function verifyGrantProof(value: unknown): GrantProofResult {
  const checked = checkProofTerms(value);
  if (!checked.ok) {
    return checked;
  }
  if (!checked.terms.eoa) {
    return { ok: false, reason: SIGNATURE_MISMATCH };
  }
  return { ok: true, grant: grantOf(checked.proof) };
}

/**
 * verifyGrantProof, and for a signature that does not recover to the
 * wallet, EIP-1271: the contract wallet accepts it over the signed hash on
 * the grant's chain (chain 1 for app grants, the SIWE chain for sign-in
 * grants), as Ethereum reads now.
 */
export async function verifyGrantProofWithChain(
  value: unknown,
  contractWallets: ContractWalletSignatureCheck
): Promise<GrantProofResult> {
  const checked = checkProofTerms(value);
  if (!checked.ok) {
    return checked;
  }
  const { terms, proof } = checked;
  if (
    terms.eoa ||
    (await contractWallets.isValidSignature({
      chainId: terms.chainId,
      wallet: terms.wallet,
      hash: terms.signedHash,
      signature: proof.wallet_signature
    }))
  ) {
    return { ok: true, grant: grantOf(proof) };
  }
  return { ok: false, reason: SIGNATURE_MISMATCH };
}

export interface GrantProofSourceOptions {
  // EIP-1271 for proofs whose signature is not the wallet's own key.
  readonly contractWallets?: ContractWalletSignatureCheck;
  // Asked for a grant none of the proofs verifies (another archive, a relay).
  readonly fallback?: RecordGrantSource;
}

/**
 * Grants from the proofs that travel with records (a log segment, a relay
 * page). A proof that does not verify is unknown here, and the fallback
 * source, when given, is asked instead.
 */
export class GrantProofRecordSource implements RecordGrantSource {
  private readonly grants = new Map<string, VerifiedGrant>();

  constructor(
    proofs: readonly unknown[],
    private readonly fallback: RecordGrantSource | null = null
  ) {
    for (const proof of proofs) {
      this.add(verifyGrantProof(proof));
    }
  }

  /** With EIP-1271 for contract wallets, which needs Ethereum reads. */
  static async from(
    proofs: readonly unknown[],
    options: GrantProofSourceOptions = {}
  ): Promise<GrantProofRecordSource> {
    const source = new GrantProofRecordSource([], options.fallback ?? null);
    for (const proof of proofs) {
      source.add(
        options.contractWallets
          ? await verifyGrantProofWithChain(proof, options.contractWallets)
          : verifyGrantProof(proof)
      );
    }
    return source;
  }

  private add(result: GrantProofResult): void {
    if (result.ok) {
      this.grants.set(result.grant.id, result.grant);
    }
  }

  async findGrant(grantId: string): Promise<VerifiedGrant | null> {
    const id = grantId.toLowerCase();
    return (
      this.grants.get(id) ??
      (this.fallback ? await this.fallback.findGrant(id) : null)
    );
  }
}
