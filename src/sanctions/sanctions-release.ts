import { getAddress, verifyMessage } from 'ethers';
import { canonicalJsonBytes } from '@/sanctions/canonical-json';
import { compareCodePoints } from '@/sanctions/sanctions-text';
import {
  MAX_SINGLE_BLOCK_BYTES,
  rawBlockCid,
  sha256Hex
} from '@/sanctions/content-address';

/**
 * The signed release envelope for a sanctions list (spec section 3.2). It
 * follows The Update Framework's shape (`signed` + `signatures`) so more
 * signers and a threshold can be added later without a format change.
 */

export const SANCTIONS_RELEASE_TYPE = '6529.sanctions-list.release';
export const SANCTIONS_KEYS_SCHEMA = '6529.sanctions-keys.v1';
export const SANCTIONS_PAYLOAD_PATH = 'sanctions-list.v1.json';
export const EIP191_SECP256K1 = 'eip191-secp256k1';

const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface SanctionsReleaseSigned {
  readonly _type: typeof SANCTIONS_RELEASE_TYPE;
  readonly spec_version: '1';
  readonly sequence: number;
  readonly published_at: string;
  readonly expires_at: string;
  readonly payload: {
    readonly path: typeof SANCTIONS_PAYLOAD_PATH;
    readonly sha256: string;
    readonly bytes: number;
    readonly cid: string;
  };
  readonly previous: {
    readonly sequence: number;
    readonly sha256: string;
  } | null;
  readonly policy: { readonly id: string; readonly version: string };
}

export interface SanctionsReleaseSignature {
  /** For `eip191-secp256k1`, the signer's lowercase Ethereum address. */
  readonly keyid: string;
  readonly method: typeof EIP191_SECP256K1;
  readonly sig: string;
}

export interface SanctionsReleaseEnvelope {
  readonly signed: SanctionsReleaseSigned;
  readonly signatures: SanctionsReleaseSignature[];
}

export interface SanctionsKeysV1 {
  readonly schema: typeof SANCTIONS_KEYS_SCHEMA;
  readonly roles: {
    readonly sanctions: {
      readonly threshold: number;
      readonly keys: Array<{ keyid: string; method: typeof EIP191_SECP256K1 }>;
    };
  };
}

/** Anything that can produce an EIP-191 `personal_sign` signature (a test key now, KMS later). */
export interface SanctionsReleaseSigner {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<string>;
}

export interface SanctionsReleaseVerification {
  readonly sequence: number;
  readonly signers: string[];
  /** Past `expires_at`: clients keep using it but warn (never fail open). */
  readonly expired: boolean;
}

export class SanctionsReleaseError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SanctionsReleaseError';
  }
}

export interface SanctionsReleaseParams {
  readonly payloadBytes: Buffer;
  readonly sequence: number;
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly previous: { sequence: number; sha256: string } | null;
  readonly policy: { id: string; version: string };
}

export function releaseSigningBytes(signed: SanctionsReleaseSigned): Buffer {
  return canonicalJsonBytes(signed);
}

export async function createSanctionsRelease(
  params: SanctionsReleaseParams,
  signers: ReadonlyArray<SanctionsReleaseSigner>
): Promise<SanctionsReleaseEnvelope> {
  if (!Number.isSafeInteger(params.sequence) || params.sequence < 1) {
    throw new SanctionsReleaseError('sequence must be a positive integer');
  }
  if (
    !UTC_SECONDS.test(params.publishedAt) ||
    !UTC_SECONDS.test(params.expiresAt)
  ) {
    throw new SanctionsReleaseError(
      'timestamps must be UTC seconds, YYYY-MM-DDTHH:MM:SSZ'
    );
  }
  const signed: SanctionsReleaseSigned = {
    _type: SANCTIONS_RELEASE_TYPE,
    spec_version: '1',
    sequence: params.sequence,
    published_at: params.publishedAt,
    expires_at: params.expiresAt,
    payload: {
      path: SANCTIONS_PAYLOAD_PATH,
      sha256: sha256Hex(params.payloadBytes),
      bytes: params.payloadBytes.length,
      cid: rawBlockCid(params.payloadBytes)
    },
    previous: params.previous,
    policy: params.policy
  };
  const message = releaseSigningBytes(signed);
  const signatures: SanctionsReleaseSignature[] = [];
  for (const signer of signers) {
    signatures.push({
      keyid: signer.address.toLowerCase(),
      method: EIP191_SECP256K1,
      sig: await signer.signMessage(message)
    });
  }
  return { signed, signatures };
}

function recoveredSigner(
  message: Buffer,
  signature: SanctionsReleaseSignature
): string | null {
  if (signature.method !== EIP191_SECP256K1) {
    return null;
  }
  try {
    return getAddress(verifyMessage(message, signature.sig)).toLowerCase();
  } catch {
    return null;
  }
}

function assertPayload(
  signed: SanctionsReleaseSigned,
  payloadBytes: Buffer
): void {
  if (payloadBytes.length > MAX_SINGLE_BLOCK_BYTES) {
    throw new SanctionsReleaseError('payload too large for a single block');
  }
  if (
    signed.payload.bytes !== payloadBytes.length ||
    signed.payload.sha256 !== sha256Hex(payloadBytes) ||
    signed.payload.cid !== rawBlockCid(payloadBytes)
  ) {
    throw new SanctionsReleaseError('payload does not match the release');
  }
}

/**
 * Verifies a release against pinned keys and its payload bytes:
 * 1. at least `threshold` distinct pinned keys signed the canonical `signed`
 *    bytes;
 * 2. the payload's size, sha256 and CID match;
 * 3. the sequence is above `minSequence` (rollback protection).
 * Expiry never fails verification; it is reported so clients can warn.
 */
export function verifySanctionsRelease(
  envelope: SanctionsReleaseEnvelope,
  keys: SanctionsKeysV1,
  payloadBytes: Buffer,
  options: { minSequence?: number; now: Date }
): SanctionsReleaseVerification {
  if (keys.schema !== SANCTIONS_KEYS_SCHEMA) {
    throw new SanctionsReleaseError('unsupported keys schema');
  }
  const { signed } = envelope;
  if (signed._type !== SANCTIONS_RELEASE_TYPE || signed.spec_version !== '1') {
    throw new SanctionsReleaseError('unsupported release type');
  }
  const role = keys.roles.sanctions;
  if (!Number.isSafeInteger(role.threshold) || role.threshold < 1) {
    throw new SanctionsReleaseError('invalid threshold');
  }
  const pinned = role.keys
    .filter((key) => key.method === EIP191_SECP256K1)
    .map((key) => key.keyid.toLowerCase());
  const message = releaseSigningBytes(signed);
  const signers: Record<string, true> = {};
  for (const signature of envelope.signatures) {
    const signer = recoveredSigner(message, signature);
    if (
      signer !== null &&
      signer === signature.keyid &&
      pinned.indexOf(signer) !== -1
    ) {
      signers[signer] = true;
    }
  }
  const valid = Object.keys(signers).sort(compareCodePoints);
  if (valid.length < role.threshold) {
    throw new SanctionsReleaseError(
      `release has ${valid.length} valid signature(s); ${role.threshold} required`
    );
  }
  assertPayload(signed, payloadBytes);
  if (
    options.minSequence !== undefined &&
    signed.sequence <= options.minSequence
  ) {
    throw new SanctionsReleaseError(
      `release ${signed.sequence} is not newer than ${options.minSequence}`
    );
  }
  return {
    sequence: signed.sequence,
    signers: valid,
    expired: options.now.getTime() > Date.parse(signed.expires_at)
  };
}
