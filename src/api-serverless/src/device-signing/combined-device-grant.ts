import {
  describeDeviceGrantScopes,
  deviceKeyFingerprint,
  DeviceGrantTerms,
  formatGrantExpiryDateUtc,
  isDeviceKey
} from './device-grant-message';

// Combined sign-in grant (NC8, DN1 + DN4): one Sign-In with Ethereum message
// grants this device's Ed25519 signing key (the DN1 resource, unchanged) and
// its MLS signature key for end-to-end encrypted messages (a second resource).
// The grant id stays the EIP-191 hash of the signed message, so the MLS
// credential identity is `6529-e2ee-v1:{wallet}:{grant id}` (D109 2.3).

export const MLS_DEVICE_GRANT_URN_PREFIX = 'urn:6529:mls-device-grant:v1';

export interface MlsDeviceGrantTerms {
  // 0x + 64 lowercase hex: the device's MLS Ed25519 signature public key,
  // which is also its E2EE device key.
  readonly deviceKey: string;
  // The MLS ciphersuite (uint16) the key is granted for.
  readonly ciphersuite: number;
  // Unix seconds, minute aligned; equal to the signing grant's expiry.
  readonly expiresAtSeconds: number;
}

/** What the server asks for when it issues a combined challenge. */
export interface MlsDeviceGrantRequest {
  readonly deviceKey: string;
  readonly ciphersuite: number;
}

const MLS_URN_PATTERN =
  /^urn:6529:mls-device-grant:v1:([1-9]\d{0,4}):([0-9a-f]{64}):([1-9]\d{0,15})$/;
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
  return [
    MLS_DEVICE_GRANT_URN_PREFIX,
    terms.ciphersuite.toString(),
    terms.deviceKey.slice(2),
    terms.expiresAtSeconds.toString()
  ].join(':');
}

/** Strict inverse of buildMlsDeviceGrantUrn. */
export function parseMlsDeviceGrantUrn(
  urn: unknown
): MlsDeviceGrantTerms | null {
  if (typeof urn !== 'string') {
    return null;
  }
  const match = MLS_URN_PATTERN.exec(urn);
  if (!match) {
    return null;
  }
  const [, ciphersuiteRaw, keyHex, expiresAtRaw] = match;
  const ciphersuite = Number(ciphersuiteRaw);
  const expiresAtSeconds = Number(expiresAtRaw);
  if (
    !isMlsCiphersuite(ciphersuite) ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds % 60 !== 0
  ) {
    return null;
  }
  return { deviceKey: `0x${keyHex}`, ciphersuite, expiresAtSeconds };
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
