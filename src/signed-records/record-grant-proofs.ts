import * as Joi from 'joi';
import {
  computeAppDeviceGrantId,
  isAppDeviceGrantMessage,
  parseAppDeviceGrantMessage,
  recoversToAppGrantWallet
} from '@/api/device-signing/app-device-grant';
import { computeDeviceGrantId } from '@/api/device-signing/device-grant-message';
import { recoverWalletMessageSigner } from '@/api/wallet-signatures/structured-wallet-signatures';
import { parseSiweWebAuthMessage } from '@/api/wallet-signatures/siwe-wallet-auth';
import type { RecordGrantProof } from './record-event';
import type { RecordGrantSource, VerifiedGrant } from './record-verify';

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SIGNATURE = /^0x([0-9a-f]{2})+$/;

export const RecordGrantProofSchema: Joi.ObjectSchema<RecordGrantProof> =
  Joi.object<RecordGrantProof>({
    id: Joi.string().pattern(HEX32).required(),
    message: Joi.string().min(1).max(8192).required(),
    wallet_signature: Joi.string().pattern(SIGNATURE).max(4096).required(),
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
}

/** An app grant (6529 Mobile and Desktop): EIP-712, an EOA signature. */
function appGrantTerms(proof: RecordGrantProof): GrantTerms | string {
  const parsed = parseAppDeviceGrantMessage(proof.message);
  if (!parsed) {
    return 'app grant message does not parse';
  }
  if (!recoversToAppGrantWallet(parsed.message, proof.wallet_signature)) {
    return 'app grant signature does not recover to its wallet';
  }
  return {
    id: computeAppDeviceGrantId(parsed.message),
    wallet: parsed.grant.wallet,
    deviceKey: parsed.grant.device_key,
    scopes: parsed.grant.scopes,
    expiresAtMs: parsed.grant.expires_at * 1000
  };
}

/** A website sign-in grant: a SIWE message, an EOA signature. */
function loginGrantTerms(proof: RecordGrantProof): GrantTerms | string {
  const parsed = parseSiweWebAuthMessage(proof.message);
  if (!parsed?.deviceGrant) {
    return 'sign-in message carries no device grant';
  }
  const wallet = parsed.address.toLowerCase();
  if (
    recoverWalletMessageSigner(proof.message, proof.wallet_signature) !== wallet
  ) {
    return 'sign-in signature does not recover to its wallet';
  }
  return {
    id: computeDeviceGrantId(proof.message),
    wallet,
    deviceKey: parsed.deviceGrant.deviceKey,
    scopes: parsed.deviceGrant.scopes,
    expiresAtMs: parsed.deviceGrant.expiresAtSeconds * 1000
  };
}

/**
 * Checks a grant proof on its own, as relays do: the message parses as a
 * grant this server issues, the id is that message's hash, the wallet
 * signature recovers to the wallet (EOA only: a contract wallet needs
 * Ethereum, so a rebuild leaves it to device_grants), and the stored key,
 * scopes and expiry are the signed ones. The revocation time is the one
 * 6529.io recorded with the proof; it is not wallet-signed.
 */
export function verifyGrantProof(value: unknown): GrantProofResult {
  const { error, value: proof } = RecordGrantProofSchema.validate(value);
  if (error) {
    return { ok: false, reason: `malformed grant proof (${error.message})` };
  }
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
  return {
    ok: true,
    grant: {
      id: proof.id,
      wallet: proof.wallet,
      deviceKey: proof.device_key,
      scopes: [...proof.scopes],
      expiresAt: proof.expires_at,
      revokedAt: proof.revoked_at
    }
  };
}

/**
 * Grants from the proofs that travel with records (a log segment, a relay
 * page). A proof that does not verify is unknown.
 */
export class GrantProofRecordSource implements RecordGrantSource {
  private readonly grants = new Map<string, VerifiedGrant>();

  constructor(proofs: readonly unknown[]) {
    for (const proof of proofs) {
      const result = verifyGrantProof(proof);
      if (result.ok) {
        this.grants.set(result.grant.id, result.grant);
      }
    }
  }

  async findGrant(grantId: string): Promise<VerifiedGrant | null> {
    return this.grants.get(grantId.toLowerCase()) ?? null;
  }
}
