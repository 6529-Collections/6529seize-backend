import { computeAddress, SigningKey } from 'ethers';

/**
 * The wallet that sends SETTLEMENT_REQUEST: an address account with
 * principal zero, which pays the fees. Its key is the setting
 * WAVES_SETTLEMENT_SENDER_KEY (environment or the shared secret), `0x` and
 * 64 hex digits. The key is never logged.
 */
export interface SettlementSigner {
  /** The wallet's address, lowercase. */
  readonly address: string;
  /** A 65-byte signature over a 32-byte digest (see signDigest). */
  sign(digest: string): string;
}

export type SettlementSignerResult =
  | { readonly ok: true; readonly signer: SettlementSigner }
  | { readonly ok: false; readonly problem: 'missing' | 'malformed' };

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Signs a 32-byte digest as it is, with no message prefix: `r || s || v`,
 * v 27 or 28, low s. This is what `eth_signTypedData_v4` gives over the
 * typed data whose digest it is, and what the chain checks a wallet's
 * signature against.
 */
export function signDigest(key: SigningKey, digest: string): string {
  if (!HEX32.test(digest)) {
    throw new Error('A digest is 0x and 64 hex digits');
  }
  return key.sign(digest).serialized;
}

export function settlementSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SettlementSignerResult {
  const raw = env.WAVES_SETTLEMENT_SENDER_KEY?.trim();
  if (!raw) return { ok: false, problem: 'missing' };
  if (!HEX32.test(raw)) return { ok: false, problem: 'malformed' };
  let key: SigningKey;
  let address: string;
  try {
    key = new SigningKey(raw);
    // Zero or a value past the curve order has no public key.
    address = computeAddress(key.publicKey).toLowerCase();
  } catch {
    // The error could quote the key.
    return { ok: false, problem: 'malformed' };
  }
  return {
    ok: true,
    signer: { address, sign: (digest) => signDigest(key, digest) }
  };
}
