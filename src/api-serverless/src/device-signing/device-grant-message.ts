import { ethers } from 'ethers';

export const GRANT_TTL_SECONDS = 180 * 24 * 60 * 60;
// Upper bound accepted when parsing a grant message: the TTL plus slack, so a
// message the server did not build with today's TTL still fails closed.
export const GRANT_MAX_LIFETIME_SECONDS = 181 * 24 * 60 * 60;
export const DEVICE_GRANT_KEY_TYPE = 'ed25519';
export const DEVICE_LABEL_MAX_LENGTH = 48;
export const DEFAULT_DEVICE_LABEL = 'Browser';

export const DEVICE_GRANT_SCOPES = [
  'post',
  'edit',
  'delete',
  'react',
  'vote'
] as const;

export type DeviceGrantScope = (typeof DEVICE_GRANT_SCOPES)[number];

export const DEFAULT_DEVICE_GRANT_SCOPES: readonly DeviceGrantScope[] = [
  'post',
  'edit',
  'delete',
  'react'
];

export interface DeviceGrantTerms {
  readonly keyType: typeof DEVICE_GRANT_KEY_TYPE;
  // 0x + 64 lowercase hex: the raw 32-byte Ed25519 public key.
  readonly deviceKey: string;
  // Canonical order, no duplicates, always includes 'post'.
  readonly scopes: readonly DeviceGrantScope[];
  // Unix seconds, minute aligned.
  readonly expiresAtSeconds: number;
}

const DEVICE_KEY_PATTERN = /^0x[0-9a-f]{64}$/;
const URN_PATTERN =
  /^urn:6529:device-grant:v1:ed25519:([0-9a-f]{64}):([a-z.]+):([1-9]\d{0,15})$/;
const DEVICE_LABEL_DISALLOWED_CHARS = /[^A-Za-z0-9 ._()-]/g;
const SPACE_RUNS = / {2,}/g;

export function isDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY_PATTERN.test(value);
}

export function isDeviceGrantScope(value: string): value is DeviceGrantScope {
  return (DEVICE_GRANT_SCOPES as readonly string[]).includes(value);
}

function scopeRank(scope: DeviceGrantScope): number {
  return DEVICE_GRANT_SCOPES.indexOf(scope);
}

/**
 * Parses the session-nonce `device_scopes` query value. Returns the scopes in
 * canonical order, or null when the list is invalid (unknown or duplicate
 * scope, or missing `post`).
 */
export function parseDeviceScopesParam(
  raw: string | undefined | null
): DeviceGrantScope[] | null {
  if (raw === undefined || raw === null) {
    return [...DEFAULT_DEVICE_GRANT_SCOPES];
  }
  const items = raw.split(',');
  if (!items.every(isDeviceGrantScope)) {
    return null;
  }
  const scopes = items as DeviceGrantScope[];
  if (new Set(scopes).size !== scopes.length || !scopes.includes('post')) {
    return null;
  }
  return [...scopes].sort((a, b) => scopeRank(a) - scopeRank(b));
}

function isCanonicalScopeList(scopes: readonly string[]): boolean {
  if (!scopes.length || scopes[0] !== 'post') {
    return false;
  }
  let previousRank = -1;
  for (const scope of scopes) {
    if (!isDeviceGrantScope(scope)) {
      return false;
    }
    const rank = scopeRank(scope);
    if (rank <= previousRank) {
      return false;
    }
    previousRank = rank;
  }
  return true;
}

export function computeGrantExpiresAtSeconds(issuedAt: Date): number {
  const nowSeconds = Math.floor(issuedAt.getTime() / 1000);
  return Math.floor(nowSeconds / 60) * 60 + GRANT_TTL_SECONDS;
}

export function isGrantLifetimeValid(
  expiresAtSeconds: number,
  issuedAt: Date
): boolean {
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
  return (
    Number.isSafeInteger(expiresAtSeconds) &&
    expiresAtSeconds % 60 === 0 &&
    expiresAtSeconds > issuedAtSeconds &&
    expiresAtSeconds - issuedAtSeconds <= GRANT_MAX_LIFETIME_SECONDS
  );
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatGrantExpiryUtc(expiresAtSeconds: number): string {
  const date = new Date(expiresAtSeconds * 1000);
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )}`;
  return `${day} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

// Fixed English abbreviations, never Intl: the date is part of signed bytes.
const UTC_MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const;

/** The grant expiry as a UTC calendar date, e.g. "29 Apr 2027" or "5 Nov 2026". */
export function formatGrantExpiryDateUtc(expiresAtSeconds: number): string {
  const date = new Date(expiresAtSeconds * 1000);
  return `${date.getUTCDate()} ${
    UTC_MONTH_ABBREVIATIONS[date.getUTCMonth()]
  } ${date.getUTCFullYear()}`;
}

export function joinScopesAsEnglish(scopes: readonly string[]): string {
  if (scopes.length <= 1) {
    return scopes.join('');
  }
  const head = scopes.slice(0, -1).join(', ');
  return `${head} and ${scopes.at(-1)}`;
}

/** What the grant statement says the device will sign for each scope. */
const DEVICE_GRANT_SCOPE_NOUNS: Readonly<Record<DeviceGrantScope, string>> = {
  post: 'posts',
  edit: 'edits',
  delete: 'deletes',
  react: 'reactions',
  vote: 'votes'
};

function rawKeyHex(deviceKey: string): string {
  return deviceKey.slice(2);
}

function deviceKeyFingerprint(deviceKey: string): string {
  const keyHex = rawKeyHex(deviceKey);
  return `${keyHex.slice(0, 8)}...${keyHex.slice(-8)}`;
}

/**
 * The statement of new grant challenges. Wallets sign these exact bytes and
 * the frontend compares them byte for byte, so any change needs a coordinated
 * frontend release that accepts the new shape first. The URN alone carries
 * the exact expiry time; the statement names its UTC date.
 */
export function renderDeviceGrantStatement(terms: DeviceGrantTerms): string {
  const signs = joinScopesAsEnglish(
    terms.scopes.map((scope) => DEVICE_GRANT_SCOPE_NOUNS[scope])
  );
  return (
    `Sign in to 6529 and turn on signed messages on this device until ` +
    `${formatGrantExpiryDateUtc(terms.expiresAtSeconds)}. ` +
    `This device will sign your ${signs} so anyone can verify they came from your wallet. ` +
    `It can't move funds, change your handle, add devices or act as an admin. ` +
    `No transaction, no gas, no token approvals. ` +
    `(Device key ${deviceKeyFingerprint(terms.deviceKey)})`
  );
}

/**
 * The statement of grant challenges issued before the current wording. Only
 * accepted when parsing, so a challenge issued just before a deploy can still
 * be signed and logged in; never rendered for new challenges.
 */
export function renderLegacyDeviceGrantStatement(
  terms: DeviceGrantTerms
): string {
  const keyHint = deviceKeyFingerprint(terms.deviceKey);
  return (
    `Sign in to 6529 and let this device post as you until ` +
    `${formatGrantExpiryUtc(terms.expiresAtSeconds)} UTC (device key ${keyHint}). ` +
    `It may ${joinScopesAsEnglish(terms.scopes)}. ` +
    `It cannot move funds, change your handle, add devices or act as an admin. ` +
    `This request does not create a blockchain transaction, cost gas, or approve tokens.`
  );
}

/** Exactly the current or the legacy statement rendered from these terms. */
export function isDeviceGrantStatement(
  statement: string | undefined,
  terms: DeviceGrantTerms
): boolean {
  return (
    statement === renderDeviceGrantStatement(terms) ||
    statement === renderLegacyDeviceGrantStatement(terms)
  );
}

export function buildDeviceGrantUrn(terms: DeviceGrantTerms): string {
  return [
    'urn:6529:device-grant:v1',
    terms.keyType,
    rawKeyHex(terms.deviceKey),
    terms.scopes.join('.'),
    terms.expiresAtSeconds.toString()
  ].join(':');
}

/**
 * Strict inverse of buildDeviceGrantUrn. Lifetime relative to the message's
 * Issued At is checked separately by isGrantLifetimeValid.
 */
export function parseDeviceGrantUrn(urn: unknown): DeviceGrantTerms | null {
  if (typeof urn !== 'string') {
    return null;
  }
  const match = URN_PATTERN.exec(urn);
  if (!match) {
    return null;
  }
  const [, keyHex, scopeList, expiresAtRaw] = match;
  const scopes = scopeList.split('.');
  const expiresAtSeconds = Number(expiresAtRaw);
  if (
    !isCanonicalScopeList(scopes) ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds % 60 !== 0
  ) {
    return null;
  }
  return {
    keyType: DEVICE_GRANT_KEY_TYPE,
    deviceKey: `0x${keyHex}`,
    scopes: scopes as DeviceGrantScope[],
    expiresAtSeconds
  };
}

export function computeDeviceGrantId(signedMessage: string): string {
  return ethers.hashMessage(signedMessage).toLowerCase();
}

export function sanitizeDeviceLabel(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(DEVICE_LABEL_DISALLOWED_CHARS, '')
    .replace(SPACE_RUNS, ' ')
    .trim()
    .slice(0, DEVICE_LABEL_MAX_LENGTH)
    .trim();
  return cleaned || DEFAULT_DEVICE_LABEL;
}

export function serializeDeviceGrantScopes(
  scopes: readonly DeviceGrantScope[]
): string {
  return scopes.join(',');
}

export function deserializeDeviceGrantScopes(
  value: string
): DeviceGrantScope[] {
  return value
    .split(',')
    .filter((scope): scope is DeviceGrantScope => isDeviceGrantScope(scope));
}
