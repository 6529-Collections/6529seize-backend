import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
  verifyTypedData
} from 'ethers';
import {
  E2EE_CIPHERSUITES,
  E2EE_GRANT_MAX_FUTURE_SKEW_SECONDS,
  E2EE_GRANT_MAX_LIFETIME_SECONDS,
  E2EE_GRANT_ORIGIN_MAX_LENGTH
} from '@/e2ee/e2ee.constants';
import {
  E2EE_V1_GRANT_SUITE,
  isCanonicalE2eeSuiteSet
} from '@/e2ee/e2ee-suite-policy';

// Wallet-signed device grant (D109 contract v1, section 2). The server never
// mints grants; it only rebuilds and verifies what the wallet signed.
//
// Two versions (D172):
// - v1: domain version "1", `uint16 ciphersuite`; honoured only for 0x004F.
// - v2: domain version "2", `uint16[] ciphersuites`, a canonical set (1-4
//   code points, strictly ascending) that names at least one accepted suite.
// The statement is the same in both.

export const E2EE_GRANT_SALT = keccak256(
  toUtf8Bytes('6529 Network pre-genesis interim 1')
);

export const E2EE_GRANT_DOMAIN = {
  name: '6529 Encrypted Messages',
  version: '1',
  salt: E2EE_GRANT_SALT
} as const;

export const E2EE_GRANT_DOMAIN_V2 = {
  name: '6529 Encrypted Messages',
  version: '2',
  salt: E2EE_GRANT_SALT
} as const;

export const E2EE_GRANT_PRIMARY_TYPE = 'MlsDeviceGrant';

export const E2EE_GRANT_TYPES = {
  MlsDeviceGrant: [
    { name: 'statement', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'ciphersuite', type: 'uint16' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'origin', type: 'string' }
  ]
};

export const E2EE_GRANT_TYPES_V2 = {
  MlsDeviceGrant: [
    { name: 'statement', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'ciphersuites', type: 'uint16[]' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'origin', type: 'string' }
  ]
};

/**
 * The grant fields as sent over the API (ApiE2eeDeviceGrant). `version`
 * absent or 1: `ciphersuite` is the signed suite. Version 2: `ciphersuites`
 * is the signed set and `ciphersuite` its lowest entry.
 */
export interface E2eeDeviceGrant {
  readonly version?: 1 | 2;
  readonly wallet: string;
  readonly device_key: string;
  readonly ciphersuite: number;
  readonly ciphersuites?: number[];
  readonly issued_at: number;
  readonly expires_at: number;
  readonly origin: string;
}

export interface E2eeGrantTypedDataMessage {
  readonly statement: string;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly ciphersuite: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly origin: string;
}

export interface E2eeGrantTypedDataMessageV2 {
  readonly statement: string;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly ciphersuites: readonly number[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly origin: string;
}

/** Whether the grant is a v2 grant (a suite set). */
export const isE2eeGrantV2 = (grant: Pick<E2eeDeviceGrant, 'version'>) =>
  grant.version === 2;

/**
 * A v2 grant as received, with `ciphersuite` set to the lowest entry of
 * `ciphersuites`; a v1 grant unchanged (without a version field).
 */
export function normalizeE2eeDeviceGrant(
  grant: E2eeDeviceGrant
): E2eeDeviceGrant {
  if (!isE2eeGrantV2(grant)) {
    const { version: _version, ciphersuites: _suites, ...v1 } = grant;
    return v1;
  }
  const ciphersuites = [...(grant.ciphersuites ?? [])];
  return {
    ...grant,
    version: 2,
    ciphersuites,
    ciphersuite: ciphersuites[0] ?? 0
  };
}

export type E2eeGrantVerifiedVia = 'eoa' | 'eip1271';

/** Contract-wallet checks on Ethereum mainnet; injectable for tests. */
export interface E2eeContractWalletVerifier {
  hasCode(wallet: string): Promise<boolean>;
  isValidSignature(
    wallet: string,
    hash: string,
    signature: string
  ): Promise<boolean>;
}

export type E2eeGrantVerification =
  | {
      readonly ok: true;
      readonly grantId: string;
      readonly verifiedVia: E2eeGrantVerifiedVia;
    }
  | { readonly ok: false; readonly reason: string };

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `YYYY-MM-DD HH:MM` in UTC, zero padded, 24 h. */
export function formatE2eeGrantExpiry(expiresAtSeconds: number): string {
  const date = new Date(expiresAtSeconds * 1000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

export function buildE2eeGrantStatement(
  grant: Pick<E2eeDeviceGrant, 'device_key' | 'expires_at'>
): string {
  const key = grant.device_key.slice(2);
  return (
    'Let this device send and read end-to-end encrypted messages as you until ' +
    `${formatE2eeGrantExpiry(grant.expires_at)} UTC (device key ` +
    `${key.slice(0, 8)}...${key.slice(-8)}). 6529 cannot read these messages. ` +
    'This signature cannot move funds, change your handle or act as an admin, ' +
    'and it does not create a blockchain transaction or cost gas.'
  );
}

export function buildE2eeGrantMessage(
  grant: E2eeDeviceGrant
): E2eeGrantTypedDataMessage | E2eeGrantTypedDataMessageV2 {
  const common = {
    statement: buildE2eeGrantStatement(grant),
    wallet: getAddress(grant.wallet),
    deviceKey: grant.device_key
  };
  const times = {
    issuedAt: grant.issued_at,
    expiresAt: grant.expires_at,
    origin: grant.origin
  };
  return isE2eeGrantV2(grant)
    ? { ...common, ciphersuites: [...(grant.ciphersuites ?? [])], ...times }
    : { ...common, ciphersuite: grant.ciphersuite, ...times };
}

/** The EIP-712 typed data of the grant's version. */
export function buildE2eeGrantTypedData(grant: E2eeDeviceGrant) {
  const v2 = isE2eeGrantV2(grant);
  return {
    domain: v2 ? E2EE_GRANT_DOMAIN_V2 : E2EE_GRANT_DOMAIN,
    types: v2 ? E2EE_GRANT_TYPES_V2 : E2EE_GRANT_TYPES,
    primaryType: E2EE_GRANT_PRIMARY_TYPE,
    message: buildE2eeGrantMessage(grant)
  };
}

/** grant_id: the EIP-712 digest of the grant, lowercase hex. */
export function computeE2eeGrantId(grant: E2eeDeviceGrant): string {
  const typed = buildE2eeGrantTypedData(grant);
  return TypedDataEncoder.hash(
    typed.domain,
    typed.types,
    typed.message
  ).toLowerCase();
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/**
 * v1: the suite must be 0x004F. v2: a canonical set naming at least one
 * accepted suite, with `ciphersuite` its lowest entry.
 */
function findE2eeGrantSuiteProblem(grant: E2eeDeviceGrant): string | null {
  if (
    grant.version !== undefined &&
    grant.version !== 1 &&
    grant.version !== 2
  ) {
    return 'version';
  }
  if (!isE2eeGrantV2(grant)) {
    return grant.ciphersuite === E2EE_V1_GRANT_SUITE ? null : 'ciphersuite';
  }
  const suites = grant.ciphersuites;
  if (!isCanonicalE2eeSuiteSet(suites)) return 'ciphersuites';
  if (!suites.some((suite) => E2EE_CIPHERSUITES.includes(suite))) {
    return 'ciphersuites';
  }
  return grant.ciphersuite === suites[0] ? null : 'ciphersuite';
}

/** Field and time checks of section 2.2 step 1; null when the grant passes. */
export function findE2eeGrantProblem(
  grant: E2eeDeviceGrant,
  nowSeconds: number
): string | null {
  if (!/^0x[0-9a-f]{40}$/.test(grant.wallet)) return 'wallet_format';
  if (!/^0x[0-9a-f]{64}$/.test(grant.device_key)) return 'device_key_format';
  const suiteProblem = findE2eeGrantSuiteProblem(grant);
  if (suiteProblem) return suiteProblem;
  if (
    !grant.origin ||
    grant.origin.length > E2EE_GRANT_ORIGIN_MAX_LENGTH ||
    !isPrintableAscii(grant.origin)
  ) {
    return 'origin';
  }
  const { issued_at: issuedAt, expires_at: expiresAt } = grant;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    return 'time_format';
  }
  if (issuedAt <= 0 || expiresAt <= issuedAt) return 'time_order';
  if (expiresAt % 60 !== 0) return 'expiry_alignment';
  if (expiresAt - issuedAt > E2EE_GRANT_MAX_LIFETIME_SECONDS) {
    return 'lifetime';
  }
  if (issuedAt > nowSeconds + E2EE_GRANT_MAX_FUTURE_SKEW_SECONDS) {
    return 'issued_in_future';
  }
  if (expiresAt <= nowSeconds) return 'expired';
  return null;
}

function recoverEoaSigner(
  grant: E2eeDeviceGrant,
  signature: string
): string | null {
  try {
    const typed = buildE2eeGrantTypedData(grant);
    return verifyTypedData(
      typed.domain,
      typed.types,
      typed.message,
      signature
    ).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verifies a device grant per section 2.2 steps 1-3. Step 4 (the wallet
 * belongs to the caller's profile) is the caller's responsibility.
 */
export async function verifyE2eeDeviceGrant({
  grant,
  signature,
  nowSeconds,
  contractWalletVerifier
}: {
  readonly grant: E2eeDeviceGrant;
  readonly signature: string;
  readonly nowSeconds: number;
  readonly contractWalletVerifier: E2eeContractWalletVerifier;
}): Promise<E2eeGrantVerification> {
  const problem = findE2eeGrantProblem(grant, nowSeconds);
  if (problem) return { ok: false, reason: problem };
  if (!/^0x([0-9a-f]{2})*$/.test(signature)) {
    return { ok: false, reason: 'signature_format' };
  }
  const grantId = computeE2eeGrantId(grant);
  if (recoverEoaSigner(grant, signature) === grant.wallet) {
    return { ok: true, grantId, verifiedVia: 'eoa' };
  }
  try {
    if (
      (await contractWalletVerifier.hasCode(grant.wallet)) &&
      (await contractWalletVerifier.isValidSignature(
        grant.wallet,
        grantId,
        signature
      ))
    ) {
      return { ok: true, grantId, verifiedVia: 'eip1271' };
    }
  } catch {
    return { ok: false, reason: 'contract_wallet_unavailable' };
  }
  return { ok: false, reason: 'signer_mismatch' };
}
