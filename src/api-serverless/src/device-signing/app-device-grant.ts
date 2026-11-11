import {
  getAddress,
  TypedDataEncoder,
  verifyTypedData,
  ZeroHash
} from 'ethers';
import { E2EE_CIPHERSUITES } from '@/e2ee/e2ee.constants';
import { E2eeContractWalletVerifier, E2EE_GRANT_SALT } from '@/e2ee/e2ee-grant';
import {
  E2EE_V1_GRANT_SUITE,
  isCanonicalE2eeSuiteSet
} from '@/e2ee/e2ee-suite-policy';
import {
  describeDeviceGrantScopes,
  DeviceGrantScope,
  deviceKeyFingerprint,
  formatGrantExpiryDateUtc,
  GRANT_MAX_LIFETIME_SECONDS,
  isDeviceKey,
  parseDeviceScopesParam
} from './device-grant-message';

// App device grant: the EIP-712 grant 6529 Mobile and 6529 Desktop sign
// outside a web sign-in. One signature grants this device's Ed25519 signing
// key and, when `mlsDeviceKey` is set, its MLS key for end-to-end encrypted
// messages (the app form of the combined sign-in grant). The grant id is the
// EIP-712 digest; it is stored in device_grants beside sign-in grants, with
// the same verification, expiry and revocation rules. Its stored `message`
// is the signed typed-data message as JSON, so anyone can rebuild the digest
// and check the wallet signature. A SIWE message never starts with "{".
//
// Two versions (D172): v1 (domain version "1") signs one `uint16
// ciphersuite`, 0x004F only; v2 (domain version "2") signs `uint16[]
// ciphersuites`, a canonical set ([] for a signing-only grant). The stored
// JSON tells them apart by that key.

export const APP_DEVICE_GRANT_DOMAIN = {
  name: '6529 Device Grant',
  version: '1',
  salt: E2EE_GRANT_SALT
} as const;

export const APP_DEVICE_GRANT_DOMAIN_V2 = {
  name: '6529 Device Grant',
  version: '2',
  salt: E2EE_GRANT_SALT
} as const;

export const APP_DEVICE_GRANT_PRIMARY_TYPE = 'DeviceGrant';

export const APP_DEVICE_GRANT_TYPES = {
  DeviceGrant: [
    { name: 'statement', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'scopes', type: 'string' },
    { name: 'mlsDeviceKey', type: 'bytes32' },
    { name: 'ciphersuite', type: 'uint16' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'origin', type: 'string' }
  ]
};

export const APP_DEVICE_GRANT_TYPES_V2 = {
  DeviceGrant: [
    { name: 'statement', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'deviceKey', type: 'bytes32' },
    { name: 'scopes', type: 'string' },
    { name: 'mlsDeviceKey', type: 'bytes32' },
    { name: 'ciphersuites', type: 'uint16[]' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'origin', type: 'string' }
  ]
};

/** Grants without an encrypted-messages key carry zero in both MLS fields. */
const NO_MLS_DEVICE_KEY = ZeroHash;
const NO_CIPHERSUITE = 0;
export const APP_DEVICE_GRANT_ORIGIN_MAX_LENGTH = 64;
/** A grant may be issued at most this far ahead of the server clock. */
const MAX_FUTURE_SKEW_SECONDS = 10 * 60;
/** A grant must be registered within a day of signing (contract wallets can be slow). */
const MAX_REGISTRATION_AGE_SECONDS = 24 * 60 * 60;

/** The grant fields as sent over the API (ApiAppDeviceGrant). */
export interface AppDeviceGrant {
  // Lowercase 0x address.
  readonly wallet: string;
  // 0x + 64 lowercase hex: the Ed25519 signing key.
  readonly device_key: string;
  // Canonical order, always includes 'post'.
  readonly scopes: readonly DeviceGrantScope[];
  // 0x + 64 lowercase hex, or null for a signing-only grant.
  readonly mls_device_key: string | null;
  // v1: the MLS suite (null without an MLS key); v2: the lowest entry of
  // `ciphersuites` (null without an MLS key).
  readonly ciphersuite: number | null;
  // Version 2 only: the signed suite set ([] without an MLS key).
  readonly version?: 1 | 2;
  readonly ciphersuites?: number[];
  // Unix seconds; expires_at is minute aligned.
  readonly issued_at: number;
  readonly expires_at: number;
  readonly origin: string;
}

interface AppDeviceGrantTypedDataFields {
  readonly statement: string;
  readonly wallet: string;
  readonly deviceKey: string;
  readonly scopes: string;
  readonly mlsDeviceKey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly origin: string;
}

/** The signed message: v1 with `ciphersuite`, v2 with `ciphersuites`. */
export type AppDeviceGrantTypedDataMessage = AppDeviceGrantTypedDataFields &
  (
    | { readonly ciphersuite: number; readonly ciphersuites?: undefined }
    | {
        readonly ciphersuites: readonly number[];
        readonly ciphersuite?: undefined;
      }
  );

export const isAppDeviceGrantV2 = (grant: Pick<AppDeviceGrant, 'version'>) =>
  grant.version === 2;

/** The EIP-712 domain and types of a signed message's version. */
function typingOf(message: AppDeviceGrantTypedDataMessage) {
  return message.ciphersuites === undefined
    ? { domain: APP_DEVICE_GRANT_DOMAIN, types: APP_DEVICE_GRANT_TYPES }
    : { domain: APP_DEVICE_GRANT_DOMAIN_V2, types: APP_DEVICE_GRANT_TYPES_V2 };
}

export const hasMlsDeviceKey = (
  grant: Pick<AppDeviceGrant, 'mls_device_key'>
): boolean => grant.mls_device_key !== null;

type StatementRenderer = (grant: AppDeviceGrant) => string;

const keysNote = (grant: AppDeviceGrant): string =>
  grant.mls_device_key === null
    ? `(Device key ${deviceKeyFingerprint(grant.device_key)})`
    : `(Device key ${deviceKeyFingerprint(grant.device_key)}, ` +
      `encrypted messages key ${deviceKeyFingerprint(grant.mls_device_key)})`;

/**
 * DRAFT wording, NOT owner-approved yet: the approved sign-in statements
 * without "Sign in to 6529 and", since the app grant is not a sign-in.
 * Changing it before release only needs this renderer and the frontend's
 * lib/device-signing/app-grant.ts (and the shared vectors) changed together.
 */
const renderAppGrantStatementDraft1: StatementRenderer = (grant) =>
  `Turn on signed messages on this device until ` +
  `${formatGrantExpiryDateUtc(grant.expires_at)}. ` +
  `This device will sign your ${describeDeviceGrantScopes(grant.scopes)} ` +
  `so anyone can verify they came from your wallet. ` +
  (grant.mls_device_key === null
    ? ''
    : `It will also encrypt (send) and decrypt (read) your end-to-end ` +
      `encrypted messages, which 6529.io cannot read. `) +
  `It can't move funds, change your handle, add devices or act as an admin. ` +
  `No transaction, no gas, no token approvals. ` +
  keysNote(grant);

/**
 * Statements, newest first. New grants use the first; verification accepts
 * every entry, so grants signed under an earlier wording keep verifying. To
 * change the wording after release, add a renderer at the front and keep the
 * old ones.
 */
const APP_GRANT_STATEMENTS: readonly StatementRenderer[] = [
  renderAppGrantStatementDraft1
];

export function renderAppDeviceGrantStatement(grant: AppDeviceGrant): string {
  return APP_GRANT_STATEMENTS[0](grant);
}

export function isAppDeviceGrantStatement(
  statement: string,
  grant: AppDeviceGrant
): boolean {
  return APP_GRANT_STATEMENTS.some((render) => render(grant) === statement);
}

export function buildAppDeviceGrantMessage(
  grant: AppDeviceGrant,
  statement: string = renderAppDeviceGrantStatement(grant)
): AppDeviceGrantTypedDataMessage {
  const fields: AppDeviceGrantTypedDataFields = {
    statement,
    wallet: getAddress(grant.wallet),
    deviceKey: grant.device_key,
    scopes: grant.scopes.join(','),
    mlsDeviceKey: grant.mls_device_key ?? NO_MLS_DEVICE_KEY,
    issuedAt: grant.issued_at,
    expiresAt: grant.expires_at,
    origin: grant.origin
  };
  return isAppDeviceGrantV2(grant)
    ? { ...fields, ciphersuites: [...(grant.ciphersuites ?? [])] }
    : { ...fields, ciphersuite: grant.ciphersuite ?? NO_CIPHERSUITE };
}

/** The grant id: the EIP-712 digest of the grant, lowercase hex. */
export function computeAppDeviceGrantId(
  message: AppDeviceGrantTypedDataMessage
): string {
  const { domain, types } = typingOf(message);
  return TypedDataEncoder.hash(domain, types, message).toLowerCase();
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

function findKeyProblem(grant: AppDeviceGrant): string | null {
  if (!/^0x[0-9a-f]{40}$/.test(grant.wallet)) return 'wallet_format';
  if (!isDeviceKey(grant.device_key)) return 'device_key_format';
  const scopes = parseDeviceScopesParam(grant.scopes.join(','));
  if (scopes?.join(',') !== grant.scopes.join(',')) return 'scopes';
  if (grant.mls_device_key === null) {
    return grant.ciphersuite === null && !grant.ciphersuites?.length
      ? null
      : 'ciphersuite';
  }
  if (!isDeviceKey(grant.mls_device_key)) return 'mls_device_key_format';
  // Two keys, so revoking or losing one never silently covers the other.
  if (grant.mls_device_key === grant.device_key) return 'mls_device_key_reused';
  return findSuiteProblem(grant);
}

/**
 * v1: the suite must be 0x004F. v2: a canonical set naming at least one
 * accepted suite, with `ciphersuite` its lowest entry.
 */
function findSuiteProblem(grant: AppDeviceGrant): string | null {
  if (!isAppDeviceGrantV2(grant)) {
    return grant.ciphersuite === E2EE_V1_GRANT_SUITE ? null : 'ciphersuite';
  }
  const suites = grant.ciphersuites;
  if (
    !isCanonicalE2eeSuiteSet(suites) ||
    !suites.some((suite) => E2EE_CIPHERSUITES.includes(suite))
  ) {
    return 'ciphersuites';
  }
  return grant.ciphersuite === suites[0] ? null : 'ciphersuite';
}

function findOriginProblem(origin: string): string | null {
  return origin &&
    origin.length <= APP_DEVICE_GRANT_ORIGIN_MAX_LENGTH &&
    isPrintableAscii(origin)
    ? null
    : 'origin';
}

function findTimeProblem(
  grant: AppDeviceGrant,
  nowSeconds: number
): string | null {
  const { issued_at: issuedAt, expires_at: expiresAt } = grant;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    return 'time_format';
  }
  if (issuedAt <= 0 || expiresAt <= issuedAt) return 'time_order';
  if (expiresAt % 60 !== 0) return 'expiry_alignment';
  if (expiresAt - issuedAt > GRANT_MAX_LIFETIME_SECONDS) return 'lifetime';
  if (expiresAt <= nowSeconds) return 'expired';
  return null;
}

/** Field and time checks of a stored or arriving grant; null when it passes. */
export function findAppDeviceGrantProblem(
  grant: AppDeviceGrant,
  nowSeconds: number
): string | null {
  return (
    findKeyProblem(grant) ??
    findOriginProblem(grant.origin) ??
    findTimeProblem(grant, nowSeconds)
  );
}

/** Extra checks for a grant being registered now. */
export function findAppDeviceGrantRegistrationProblem(
  grant: AppDeviceGrant,
  nowSeconds: number
): string | null {
  const problem = findAppDeviceGrantProblem(grant, nowSeconds);
  if (problem) return problem;
  if (grant.issued_at > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    return 'issued_in_future';
  }
  if (grant.issued_at < nowSeconds - MAX_REGISTRATION_AGE_SECONDS) {
    return 'issued_too_long_ago';
  }
  return null;
}

export type AppDeviceGrantVerifiedVia = 'eoa' | 'eip1271';

export type AppDeviceGrantVerification =
  | {
      readonly ok: true;
      readonly grantId: string;
      readonly message: AppDeviceGrantTypedDataMessage;
      readonly verifiedVia: AppDeviceGrantVerifiedVia;
    }
  | { readonly ok: false; readonly reason: string };

/** Whether the signature recovers (ECDSA) to the grant's wallet. */
export function recoversToAppGrantWallet(
  message: AppDeviceGrantTypedDataMessage,
  signature: string
): boolean {
  try {
    const { domain, types } = typingOf(message);
    return (
      verifyTypedData(domain, types, message, signature).toLowerCase() ===
      message.wallet.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Verifies the wallet signature over a grant whose fields already passed
 * findAppDeviceGrantRegistrationProblem: an EOA signature, or an EIP-1271
 * contract wallet on Ethereum mainnet. The server always signs off on its
 * own statement, never one the client sent.
 */
export async function verifyAppDeviceGrant({
  grant,
  signature,
  contractWalletVerifier
}: {
  readonly grant: AppDeviceGrant;
  readonly signature: string;
  readonly contractWalletVerifier: E2eeContractWalletVerifier;
}): Promise<AppDeviceGrantVerification> {
  if (!/^0x([0-9a-f]{2})+$/.test(signature)) {
    return { ok: false, reason: 'signature_format' };
  }
  const message = buildAppDeviceGrantMessage(grant);
  const grantId = computeAppDeviceGrantId(message);
  if (recoversToAppGrantWallet(message, signature)) {
    return { ok: true, grantId, message, verifiedVia: 'eoa' };
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
      return { ok: true, grantId, message, verifiedVia: 'eip1271' };
    }
  } catch {
    return { ok: false, reason: 'contract_wallet_unavailable' };
  }
  return { ok: false, reason: 'signer_mismatch' };
}

/** The stored `message`: the signed typed-data message, keys in type order. */
export function serializeAppDeviceGrantMessage(
  message: AppDeviceGrantTypedDataMessage
): string {
  const suites =
    message.ciphersuites === undefined
      ? { ciphersuite: message.ciphersuite }
      : { ciphersuites: message.ciphersuites };
  return JSON.stringify({
    statement: message.statement,
    wallet: message.wallet,
    deviceKey: message.deviceKey,
    scopes: message.scopes,
    mlsDeviceKey: message.mlsDeviceKey,
    ...suites,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    origin: message.origin
  });
}

/** Whether a stored grant message is an app grant (JSON) and not SIWE text. */
export function isAppDeviceGrantMessage(message: string): boolean {
  return message.startsWith('{');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readTypedMessage(
  value: Record<string, unknown>
): AppDeviceGrantTypedDataMessage | null {
  const {
    statement,
    wallet,
    deviceKey,
    scopes,
    mlsDeviceKey,
    issuedAt,
    expiresAt,
    origin
  } = value;
  if (
    typeof statement !== 'string' ||
    typeof wallet !== 'string' ||
    typeof deviceKey !== 'string' ||
    typeof scopes !== 'string' ||
    typeof mlsDeviceKey !== 'string' ||
    typeof issuedAt !== 'number' ||
    typeof expiresAt !== 'number' ||
    typeof origin !== 'string'
  ) {
    return null;
  }
  const fields = {
    statement,
    wallet,
    deviceKey,
    scopes,
    mlsDeviceKey,
    issuedAt,
    expiresAt,
    origin
  };
  return readSuites(fields, value);
}

/** v1 (`ciphersuite`, a number) or v2 (`ciphersuites`, numbers), not both. */
function readSuites(
  fields: AppDeviceGrantTypedDataFields,
  value: Record<string, unknown>
): AppDeviceGrantTypedDataMessage | null {
  const { ciphersuite, ciphersuites } = value;
  if (typeof ciphersuite === 'number' && ciphersuites === undefined) {
    return { ...fields, ciphersuite };
  }
  if (
    ciphersuite === undefined &&
    Array.isArray(ciphersuites) &&
    ciphersuites.every((suite) => typeof suite === 'number')
  ) {
    return { ...fields, ciphersuites: ciphersuites as number[] };
  }
  return null;
}

/**
 * Reads a stored app grant message back into its grant and typed message.
 * Null unless it is well formed and its statement is one this server
 * renders for exactly those fields.
 */
export function parseAppDeviceGrantMessage(text: string): {
  readonly grant: AppDeviceGrant;
  readonly message: AppDeviceGrantTypedDataMessage;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const message = isRecord(parsed) ? readTypedMessage(parsed) : null;
  if (!message || !/^0x[0-9a-fA-F]{40}$/.test(message.wallet)) {
    return null;
  }
  const scopes = parseDeviceScopesParam(message.scopes);
  const v2 = message.ciphersuites !== undefined;
  const withoutMls =
    message.mlsDeviceKey === NO_MLS_DEVICE_KEY &&
    (v2
      ? message.ciphersuites.length === 0
      : message.ciphersuite === NO_CIPHERSUITE);
  const lowest = v2 ? message.ciphersuites[0] : message.ciphersuite;
  const grant: AppDeviceGrant = {
    wallet: message.wallet.toLowerCase(),
    device_key: message.deviceKey,
    scopes: scopes ?? [],
    mls_device_key: withoutMls ? null : message.mlsDeviceKey,
    ciphersuite: withoutMls ? null : (lowest ?? null),
    ...(v2
      ? { version: 2 as const, ciphersuites: [...message.ciphersuites] }
      : {}),
    issued_at: message.issuedAt,
    expires_at: message.expiresAt,
    origin: message.origin
  };
  if (
    !scopes ||
    findKeyProblem(grant) ||
    findOriginProblem(grant.origin) ||
    !isAppDeviceGrantStatement(message.statement, grant)
  ) {
    return null;
  }
  return { grant, message };
}
