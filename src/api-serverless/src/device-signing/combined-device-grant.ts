import {
  describeDeviceGrantScopes,
  deviceKeyFingerprint,
  DeviceGrantTerms,
  formatGrantExpiryDateUtc,
  isDeviceKey
} from './device-grant-message';
import { isCanonicalE2eeSuiteSet } from '@/e2ee/e2ee-suite-policy';

// Combined sign-in grant (NC8, DN1 + DN4): one Sign-In with Ethereum message
// grants this device's Ed25519 signing key (the DN1 resource, unchanged) and
// its MLS signature key for end-to-end encrypted messages (a second resource).
// The grant id stays the EIP-191 hash of the signed message, so the MLS
// credential identity is `6529-e2ee-v1:{wallet}:{grant id}` (D109 2.3).
//
// Two resource versions (D172): v1 names one suite
// (`urn:6529:mls-device-grant:v1:79:<key>:<expiry>`), v2 a canonical suite
// set joined by "." (`urn:6529:mls-device-grant:v2:78:<key>:<expiry>`).

export const MLS_DEVICE_GRANT_URN_PREFIX = 'urn:6529:mls-device-grant:v1';
export const MLS_DEVICE_GRANT_URN_PREFIX_V2 = 'urn:6529:mls-device-grant:v2';

export interface MlsDeviceGrantTerms {
  // 1: one `ciphersuite`; 2: a suite set (`ciphersuites`).
  readonly version: 1 | 2;
  // 0x + 64 lowercase hex: the device's MLS Ed25519 signature public key,
  // which is also its E2EE device key.
  readonly deviceKey: string;
  // v1: the MLS ciphersuite (uint16) the key is granted for; v2: the
  // lowest entry of `ciphersuites`.
  readonly ciphersuite: number;
  // The granted suites: [ciphersuite] for v1, the signed set for v2.
  readonly ciphersuites: readonly number[];
  // Unix seconds, minute aligned; equal to the signing grant's expiry.
  readonly expiresAtSeconds: number;
}

/**
 * What the server asks for when it issues a combined challenge: a v2 suite
 * set (`ciphersuites`), or a v1 single suite (`ciphersuite`).
 */
export type MlsDeviceGrantRequest =
  | { readonly deviceKey: string; readonly ciphersuite: number }
  | { readonly deviceKey: string; readonly ciphersuites: readonly number[] };

const MLS_URN_PATTERN =
  /^urn:6529:mls-device-grant:v1:([1-9]\d{0,4}):([0-9a-f]{64}):([1-9]\d{0,15})$/;
const MLS_URN_PATTERN_V2 =
  /^urn:6529:mls-device-grant:v2:([1-9]\d{0,4}(?:\.[1-9]\d{0,4}){0,3}):([0-9a-f]{64}):([1-9]\d{0,15})$/;
const MAX_CIPHERSUITE = 0xffff;

export function isMlsCiphersuite(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CIPHERSUITE
  );
}

export function buildMlsDeviceGrantUrn(terms: MlsDeviceGrantTerms): string {
  const v2 = terms.version === 2;
  return [
    v2 ? MLS_DEVICE_GRANT_URN_PREFIX_V2 : MLS_DEVICE_GRANT_URN_PREFIX,
    v2 ? terms.ciphersuites.join('.') : terms.ciphersuite.toString(),
    terms.deviceKey.slice(2),
    terms.expiresAtSeconds.toString()
  ].join(':');
}

/** The terms a combined challenge grants for this request. */
export function toMlsDeviceGrantTermsOf(
  request: MlsDeviceGrantRequest,
  expiresAtSeconds: number
): MlsDeviceGrantTerms {
  if ('ciphersuites' in request) {
    return {
      version: 2,
      deviceKey: request.deviceKey,
      ciphersuite: request.ciphersuites[0] ?? 0,
      ciphersuites: [...request.ciphersuites],
      expiresAtSeconds
    };
  }
  return {
    version: 1,
    deviceKey: request.deviceKey,
    ciphersuite: request.ciphersuite,
    ciphersuites: [request.ciphersuite],
    expiresAtSeconds
  };
}

function parseExpiry(raw: string): number | null {
  const expiresAtSeconds = Number(raw);
  return Number.isSafeInteger(expiresAtSeconds) && expiresAtSeconds % 60 === 0
    ? expiresAtSeconds
    : null;
}

/** Strict inverse of buildMlsDeviceGrantUrn (v1 and v2). */
export function parseMlsDeviceGrantUrn(
  urn: unknown
): MlsDeviceGrantTerms | null {
  if (typeof urn !== 'string') {
    return null;
  }
  const v1 = MLS_URN_PATTERN.exec(urn);
  if (v1) {
    const [, ciphersuiteRaw, keyHex, expiresAtRaw] = v1;
    const ciphersuite = Number(ciphersuiteRaw);
    const expiresAtSeconds = parseExpiry(expiresAtRaw);
    if (!isMlsCiphersuite(ciphersuite) || expiresAtSeconds === null) {
      return null;
    }
    return {
      version: 1,
      deviceKey: `0x${keyHex}`,
      ciphersuite,
      ciphersuites: [ciphersuite],
      expiresAtSeconds
    };
  }
  const v2 = MLS_URN_PATTERN_V2.exec(urn);
  if (!v2) {
    return null;
  }
  const [, suitesRaw, keyHex, expiresAtRaw] = v2;
  const ciphersuites = suitesRaw.split('.').map(Number);
  const expiresAtSeconds = parseExpiry(expiresAtRaw);
  if (!isCanonicalE2eeSuiteSet(ciphersuites) || expiresAtSeconds === null) {
    return null;
  }
  return {
    version: 2,
    deviceKey: `0x${keyHex}`,
    ciphersuite: ciphersuites[0],
    ciphersuites,
    expiresAtSeconds
  };
}

/**
 * The two grants of one combined message: one expiry, and two different keys
 * so revoking or losing one never silently covers the other (P35 2.3).
 */
export function isCombinedGrantPair(
  signing: DeviceGrantTerms,
  mls: MlsDeviceGrantTerms
): boolean {
  return (
    isDeviceKey(mls.deviceKey) &&
    isMlsCiphersuite(mls.ciphersuite) &&
    mls.expiresAtSeconds === signing.expiresAtSeconds &&
    mls.deviceKey !== signing.deviceKey
  );
}

type CombinedStatementRenderer = (
  signing: DeviceGrantTerms,
  mls: MlsDeviceGrantTerms
) => string;

/**
 * v1 wording (owner-approved 2026-10-31): the approved signed-messages
 * statement plus one sentence for encrypted messages and the second key.
 */
const renderCombinedGrantStatementV1: CombinedStatementRenderer = (
  signing,
  mls
) =>
  `Sign in to 6529 and turn on signed messages on this device until ` +
  `${formatGrantExpiryDateUtc(signing.expiresAtSeconds)}. ` +
  `This device will sign your ${describeDeviceGrantScopes(signing.scopes)} ` +
  `so anyone can verify they came from your wallet. ` +
  `It will also encrypt (send) and decrypt (read) your end-to-end encrypted ` +
  `messages, which 6529.io cannot read. ` +
  `It can't move funds, change your handle, add devices or act as an admin. ` +
  `No transaction, no gas, no token approvals. ` +
  `(Device key ${deviceKeyFingerprint(signing.deviceKey)}, ` +
  `encrypted messages key ${deviceKeyFingerprint(mls.deviceKey)})`;

/**
 * Combined statements, newest first. New challenges use the first; parsing
 * accepts every entry, so grants signed under an earlier wording keep
 * verifying. To change the wording: add a renderer at the front, keep the
 * old ones, and mirror the change (and the shared vector) in the frontend's
 * lib/device-signing/combined-grant.ts before this backend issues it.
 */
const COMBINED_GRANT_STATEMENTS: readonly CombinedStatementRenderer[] = [
  renderCombinedGrantStatementV1
];

export function renderCombinedGrantStatement(
  signing: DeviceGrantTerms,
  mls: MlsDeviceGrantTerms
): string {
  return COMBINED_GRANT_STATEMENTS[0](signing, mls);
}

export function isCombinedGrantStatement(
  statement: string | undefined,
  signing: DeviceGrantTerms,
  mls: MlsDeviceGrantTerms
): boolean {
  return COMBINED_GRANT_STATEMENTS.some(
    (render) => render(signing, mls) === statement
  );
}
