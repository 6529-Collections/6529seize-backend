import { createHash, randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import * as jwt from 'jsonwebtoken';
import { SiweMessage } from 'siwe';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { normalizeWebAppOrigin } from '@/api/web-app-origins';
import {
  buildDeviceGrantUrn,
  computeGrantExpiresAtSeconds,
  DEVICE_GRANT_KEY_TYPE,
  DeviceGrantScope,
  DeviceGrantTerms,
  isDeviceGrantStatement,
  isGrantLifetimeValid,
  parseDeviceGrantUrn,
  renderDeviceGrantStatement
} from '@/api/device-signing/device-grant-message';
import {
  buildMlsDeviceGrantUrn,
  isCombinedGrantPair,
  isCombinedGrantStatement,
  MlsDeviceGrantRequest,
  MlsDeviceGrantTerms,
  parseMlsDeviceGrantUrn,
  renderCombinedGrantStatement
} from '@/api/device-signing/combined-device-grant';
import {
  getStructuredWalletSignatureAudienceForHost,
  isStructuredSignatureDomainAllowed,
  isStructuredWalletSignatureMessage,
  verifyWalletMessageSignature
} from '@/api/wallet-signatures/structured-wallet-signatures';

const logger = Logger.get('SIWE_WALLET_AUTH');

export const SIWE_WALLET_AUTH_TTL_SECONDS = 5 * 60;
export const SIWE_WALLET_AUTH_MAX_FUTURE_SKEW_SECONDS = 60;
export const SIWE_WALLET_AUTH_ISSUER = '6529-seize-api';
export const SIWE_WALLET_AUTH_SUBJECT = 'wallet-auth-session-challenge';
export const SIWE_WALLET_AUTH_STATEMENT =
  'Sign in to 6529. This request does not create a blockchain transaction, cost gas, or approve tokens.';

const SIWE_VERSION = '1';
const SIWE_CHALLENGE_TYPE = 'wallet_auth';
const SIWE_CHALLENGE_FORMAT = 'siwe';
const SIWE_CHALLENGE_VERSION = 1;
const JWT_ALGORITHM = 'HS256';
const NONCE_PATTERN = /^[A-Za-z0-9]{8,128}$/;
const localConsumedNonceExpirations = new Map<string, number>();
const ENVELOPE_KEYS = new Set([
  'challenge_type',
  'challenge_version',
  'challenge_format',
  'message',
  'client_type',
  'client_origin',
  'iat',
  'exp',
  'iss',
  'sub',
  'aud'
]);

export interface CreatedSiweWebAuthChallenge {
  readonly message: string;
  readonly clientOrigin: string;
  readonly domain: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
  readonly deviceGrant: DeviceGrantTerms | null;
  // Present only for combined challenges that also grant an MLS device key.
  readonly mlsDeviceGrant: MlsDeviceGrantTerms | null;
}

export interface SiweDeviceGrantRequest {
  readonly deviceKey: string;
  readonly scopes: readonly DeviceGrantScope[];
  // Also grant this MLS device key for encrypted messages (combined grant).
  readonly mlsDevice?: MlsDeviceGrantRequest | null;
}

export interface ParsedSiweWebAuthMessage {
  readonly message: string;
  readonly scheme: string;
  readonly domain: string;
  readonly address: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expirationTime: Date;
  // Present only for messages that also grant a device signing key.
  readonly deviceGrant: DeviceGrantTerms | null;
  // Present only for combined grants that also grant an MLS device key.
  readonly mlsDeviceGrant: MlsDeviceGrantTerms | null;
}

export interface VerifiedSiweWebAuth {
  readonly address: string;
  readonly domain: string;
  readonly nonce: string;
  readonly expirationTime: Date;
  readonly chainId: number;
  readonly issuedAt: Date;
  readonly deviceGrant: DeviceGrantTerms | null;
  readonly mlsDeviceGrant: MlsDeviceGrantTerms | null;
}

export type VerifiedSessionChallenge =
  | {
      readonly format: 'siwe';
      readonly message: string;
      readonly clientOrigin: string;
      readonly apiAudience: string;
    }
  | {
      readonly format: 'legacy';
      readonly message: string;
    };

interface CreateSiweWebAuthChallengeParams {
  readonly address: string;
  readonly clientOrigin: string;
  readonly chainId: number;
  readonly nonce?: string;
  readonly issuedAt?: Date;
  readonly deviceGrant?: SiweDeviceGrantRequest | null;
}

interface SignSiweWebAuthChallengeParams {
  readonly challenge: CreatedSiweWebAuthChallenge;
  readonly apiAudience: string;
  readonly jwtSecret: string;
}

interface VerifySessionChallengeTokenParams {
  readonly token: string;
  readonly expectedApiAudience: string | null;
  readonly jwtSecret: string;
  readonly now?: Date;
}

interface VerifySiweWebAuthSignatureParams {
  readonly message: string;
  readonly signature: string;
  readonly expectedAddress: string;
  readonly expectedChainId: number;
  readonly expectedClientOrigin: string;
  readonly now?: Date;
}

interface SiweChallengeEnvelope extends jwt.JwtPayload {
  readonly challenge_type: typeof SIWE_CHALLENGE_TYPE;
  readonly challenge_version: typeof SIWE_CHALLENGE_VERSION;
  readonly challenge_format: typeof SIWE_CHALLENGE_FORMAT;
  readonly message: string;
  readonly client_type: 'web';
  readonly client_origin: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: typeof SIWE_WALLET_AUTH_ISSUER;
  readonly sub: typeof SIWE_WALLET_AUTH_SUBJECT;
  readonly aud: string;
}

export function generateSiweWalletAuthNonce(): string {
  return randomBytes(16).toString('hex');
}

export function resolveSiweWalletAuthApiAudience(
  apiHostHeader: unknown
): string | null {
  if (typeof apiHostHeader !== 'string') {
    return null;
  }
  const rawHost = apiHostHeader.trim().toLowerCase();
  if (
    !rawHost ||
    rawHost.includes('://') ||
    rawHost.includes('@') ||
    rawHost.includes('/') ||
    rawHost.includes('\\') ||
    rawHost.includes('?') ||
    rawHost.includes('#') ||
    /\s/.test(rawHost)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`https://${rawHost}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return getStructuredWalletSignatureAudienceForHost(rawHost);
}

export function createSiweWebAuthChallenge({
  address,
  clientOrigin,
  chainId,
  nonce = generateSiweWalletAuthNonce(),
  issuedAt = new Date(),
  deviceGrant = null
}: CreateSiweWebAuthChallengeParams): CreatedSiweWebAuthChallenge {
  const normalizedOrigin = normalizeWebAppOrigin(clientOrigin);
  const issuedAtSeconds = toWholeSecondDate(issuedAt);
  if (
    !normalizedOrigin ||
    normalizedOrigin !== clientOrigin ||
    !Number.isInteger(chainId) ||
    chainId < 1 ||
    !NONCE_PATTERN.test(nonce) ||
    Number.isNaN(issuedAtSeconds.getTime())
  ) {
    throw new Error('Invalid SIWE wallet auth challenge');
  }

  const originUrl = new URL(normalizedOrigin);
  const checksummedAddress = ethers.getAddress(address);
  const expirationTime = new Date(
    issuedAtSeconds.getTime() + SIWE_WALLET_AUTH_TTL_SECONDS * 1000
  );
  const grantTerms = deviceGrant
    ? toDeviceGrantTerms(deviceGrant, issuedAtSeconds)
    : null;
  const mlsTerms =
    grantTerms && deviceGrant?.mlsDevice
      ? toMlsDeviceGrantTerms(deviceGrant.mlsDevice, grantTerms)
      : null;
  const siweMessage = new SiweMessage({
    scheme: originUrl.protocol.slice(0, -1),
    domain: originUrl.host,
    address: checksummedAddress,
    statement: renderChallengeStatement(grantTerms, mlsTerms),
    uri: normalizedOrigin,
    version: SIWE_VERSION,
    chainId,
    nonce,
    issuedAt: issuedAtSeconds.toISOString(),
    expirationTime: expirationTime.toISOString(),
    ...(grantTerms
      ? { resources: buildChallengeResources(grantTerms, mlsTerms) }
      : {})
  });

  return {
    message: siweMessage.prepareMessage(),
    clientOrigin: normalizedOrigin,
    domain: originUrl.host,
    nonce,
    issuedAt: issuedAtSeconds,
    expirationTime,
    deviceGrant: grantTerms,
    mlsDeviceGrant: mlsTerms
  };
}

function renderChallengeStatement(
  grantTerms: DeviceGrantTerms | null,
  mlsTerms: MlsDeviceGrantTerms | null
): string {
  if (!grantTerms) {
    return SIWE_WALLET_AUTH_STATEMENT;
  }
  return mlsTerms
    ? renderCombinedGrantStatement(grantTerms, mlsTerms)
    : renderDeviceGrantStatement(grantTerms);
}

function buildChallengeResources(
  grantTerms: DeviceGrantTerms,
  mlsTerms: MlsDeviceGrantTerms | null
): string[] {
  const resources = [buildDeviceGrantUrn(grantTerms)];
  if (mlsTerms) {
    resources.push(buildMlsDeviceGrantUrn(mlsTerms));
  }
  return resources;
}

function toMlsDeviceGrantTerms(
  request: MlsDeviceGrantRequest,
  grantTerms: DeviceGrantTerms
): MlsDeviceGrantTerms {
  const terms: MlsDeviceGrantTerms = {
    deviceKey: request.deviceKey,
    ciphersuite: request.ciphersuite,
    expiresAtSeconds: grantTerms.expiresAtSeconds
  };
  // Round trip through the parser so only messages it accepts are issued.
  const parsed = parseMlsDeviceGrantUrn(buildMlsDeviceGrantUrn(terms));
  if (!parsed || !isCombinedGrantPair(grantTerms, parsed)) {
    throw new Error('Invalid SIWE MLS device grant');
  }
  return parsed;
}

function toDeviceGrantTerms(
  request: SiweDeviceGrantRequest,
  issuedAt: Date
): DeviceGrantTerms {
  const terms: DeviceGrantTerms = {
    keyType: DEVICE_GRANT_KEY_TYPE,
    deviceKey: request.deviceKey,
    scopes: [...request.scopes],
    expiresAtSeconds: computeGrantExpiresAtSeconds(issuedAt)
  };
  // Round trip through the parser so only messages it accepts are issued.
  const parsed = parseDeviceGrantUrn(buildDeviceGrantUrn(terms));
  if (!parsed || !isGrantLifetimeValid(parsed.expiresAtSeconds, issuedAt)) {
    throw new Error('Invalid SIWE device grant');
  }
  return parsed;
}

export function signSiweWebAuthChallenge({
  challenge,
  apiAudience,
  jwtSecret
}: SignSiweWebAuthChallengeParams): string {
  const parsed = parseSiweWebAuthMessage(challenge.message);
  if (
    parsed?.uri !== challenge.clientOrigin ||
    parsed.domain !== challenge.domain ||
    parsed.nonce !== challenge.nonce ||
    parsed.issuedAt.getTime() !== challenge.issuedAt.getTime() ||
    parsed.expirationTime.getTime() !== challenge.expirationTime.getTime()
  ) {
    throw new Error('Invalid SIWE wallet auth challenge');
  }
  const issuedAtSeconds = toEpochSeconds(challenge.issuedAt);
  const lifetimeSeconds =
    toEpochSeconds(challenge.expirationTime) - issuedAtSeconds;
  return jwt.sign(
    {
      challenge_type: SIWE_CHALLENGE_TYPE,
      challenge_version: SIWE_CHALLENGE_VERSION,
      challenge_format: SIWE_CHALLENGE_FORMAT,
      message: challenge.message,
      client_type: 'web',
      client_origin: challenge.clientOrigin,
      iat: issuedAtSeconds
    },
    jwtSecret,
    {
      algorithm: JWT_ALGORITHM,
      issuer: SIWE_WALLET_AUTH_ISSUER,
      subject: SIWE_WALLET_AUTH_SUBJECT,
      audience: apiAudience,
      expiresIn: lifetimeSeconds
    }
  );
}

export function verifySessionChallengeToken({
  token,
  expectedApiAudience,
  jwtSecret,
  now = new Date()
}: VerifySessionChallengeTokenParams): VerifiedSessionChallenge {
  let verified: string | jwt.JwtPayload;
  try {
    verified = jwt.verify(token, jwtSecret, {
      algorithms: [JWT_ALGORITHM],
      clockTimestamp: toEpochSeconds(now)
    });
  } catch {
    throw new Error('Invalid wallet auth challenge');
  }

  if (typeof verified === 'string') {
    if (!isStructuredWalletSignatureMessage(verified)) {
      throw new Error('Invalid wallet auth challenge');
    }
    return { format: 'legacy', message: verified };
  }

  if (
    !expectedApiAudience ||
    !isSiweChallengeEnvelope(verified) ||
    verified.aud !== expectedApiAudience
  ) {
    throw new Error('Invalid wallet auth challenge');
  }

  const parsed = parseSiweWebAuthMessage(verified.message);
  if (
    parsed?.uri !== verified.client_origin ||
    toEpochSeconds(parsed.issuedAt) !== verified.iat ||
    toEpochSeconds(parsed.expirationTime) !== verified.exp
  ) {
    throw new Error('Invalid wallet auth challenge');
  }

  return {
    format: 'siwe',
    message: verified.message,
    clientOrigin: verified.client_origin,
    apiAudience: verified.aud
  };
}

export function parseSiweWebAuthMessage(
  message: string
): ParsedSiweWebAuthMessage | null {
  try {
    const parsed = new SiweMessage(message);
    const normalizedUri = normalizeWebAppOrigin(parsed.uri);
    const issuedAt = parseCanonicalDate(parsed.issuedAt);
    const expirationTime = parseCanonicalDate(parsed.expirationTime);
    const checksummedAddress = ethers.getAddress(parsed.address);
    if (
      parsed.prepareMessage() !== message ||
      parsed.scheme === undefined ||
      parsed.version !== SIWE_VERSION ||
      parsed.address !== checksummedAddress ||
      !normalizedUri ||
      parsed.uri !== normalizedUri ||
      parsed.domain !== new URL(normalizedUri).host ||
      parsed.scheme !== new URL(normalizedUri).protocol.slice(0, -1) ||
      !Number.isInteger(parsed.chainId) ||
      parsed.chainId < 1 ||
      !NONCE_PATTERN.test(parsed.nonce) ||
      !issuedAt ||
      !expirationTime ||
      expirationTime.getTime() <= issuedAt.getTime() ||
      expirationTime.getTime() - issuedAt.getTime() >
        SIWE_WALLET_AUTH_TTL_SECONDS * 1000 ||
      parsed.notBefore !== undefined ||
      parsed.requestId !== undefined
    ) {
      return null;
    }
    const variant = parseStatementVariant(
      parsed.statement,
      parsed.resources,
      issuedAt
    );
    if (!variant) {
      return null;
    }

    return {
      message,
      scheme: parsed.scheme,
      domain: parsed.domain,
      address: parsed.address,
      uri: parsed.uri,
      chainId: parsed.chainId,
      nonce: parsed.nonce,
      issuedAt,
      expirationTime,
      deviceGrant: variant.deviceGrant,
      mlsDeviceGrant: variant.mlsDeviceGrant
    };
  } catch {
    return null;
  }
}

interface StatementVariant {
  readonly deviceGrant: DeviceGrantTerms | null;
  readonly mlsDeviceGrant: MlsDeviceGrantTerms | null;
}

/**
 * Accepts exactly three shapes: the plain login (constant statement, no
 * resources); a device grant (one valid grant URN and the current or the
 * legacy statement rendered from it); or a combined grant (that grant URN,
 * then one MLS device grant URN with the same expiry and a different key,
 * and a combined statement rendered from both). Everything else fails closed.
 */
function parseStatementVariant(
  statement: string | undefined,
  resources: string[] | undefined,
  issuedAt: Date
): StatementVariant | null {
  if (resources === undefined) {
    return statement === SIWE_WALLET_AUTH_STATEMENT
      ? { deviceGrant: null, mlsDeviceGrant: null }
      : null;
  }
  if (
    !Array.isArray(resources) ||
    resources.length < 1 ||
    resources.length > 2
  ) {
    return null;
  }
  const grant = parseDeviceGrantUrn(resources[0]);
  if (!grant || !isGrantLifetimeValid(grant.expiresAtSeconds, issuedAt)) {
    return null;
  }
  if (resources.length === 1) {
    return isDeviceGrantStatement(statement, grant)
      ? { deviceGrant: grant, mlsDeviceGrant: null }
      : null;
  }
  const mls = parseMlsDeviceGrantUrn(resources[1]);
  if (
    !mls ||
    !isCombinedGrantPair(grant, mls) ||
    !isCombinedGrantStatement(statement, grant, mls)
  ) {
    return null;
  }
  return { deviceGrant: grant, mlsDeviceGrant: mls };
}

export async function verifySiweWebAuthSignature({
  message,
  signature,
  expectedAddress,
  expectedChainId,
  expectedClientOrigin,
  now = new Date()
}: VerifySiweWebAuthSignatureParams): Promise<VerifiedSiweWebAuth | null> {
  const parsed = parseSiweWebAuthMessage(message);
  const normalizedExpectedOrigin = normalizeWebAppOrigin(expectedClientOrigin);
  if (
    !parsed ||
    !normalizedExpectedOrigin ||
    normalizedExpectedOrigin !== expectedClientOrigin ||
    !ethers.isAddress(expectedAddress) ||
    parsed.address.toLowerCase() !== expectedAddress.toLowerCase() ||
    parsed.chainId !== expectedChainId ||
    parsed.uri !== normalizedExpectedOrigin ||
    !isStructuredSignatureDomainAllowed(parsed.domain) ||
    !isSiweTimingValid(parsed, now)
  ) {
    return null;
  }

  const signingAddress = await verifyWalletMessageSignature({
    message,
    signature,
    expectedAddress,
    chainId: expectedChainId
  });
  if (signingAddress !== expectedAddress.toLowerCase()) {
    return null;
  }

  return {
    address: signingAddress,
    domain: parsed.domain,
    nonce: parsed.nonce,
    expirationTime: parsed.expirationTime,
    chainId: parsed.chainId,
    issuedAt: parsed.issuedAt,
    deviceGrant: parsed.deviceGrant,
    mlsDeviceGrant: parsed.mlsDeviceGrant
  };
}

export async function consumeSiweWalletAuthNonce(
  verified: VerifiedSiweWebAuth
): Promise<boolean> {
  const expiresAtMs = verified.expirationTime.getTime();
  const remainingLifetimeMs = expiresAtMs - Date.now();
  if (remainingLifetimeMs <= 0) {
    return false;
  }
  const nonceHash = createHash('sha256').update(verified.nonce).digest('hex');
  const key = [
    'wallet_auth_siwe_nonce_v1',
    verified.address.toLowerCase(),
    nonceHash
  ].join(':');
  const ttlSeconds = Math.ceil(remainingLifetimeMs / 1000);
  const redis = getRedisClient();
  if (!redis) {
    if (canUseLocalNonceReplayFallback()) {
      return consumeLocalNonce(key, expiresAtMs);
    }
    logger.error('SIWE wallet auth replay protection unavailable');
    return false;
  }

  try {
    const result = await redis.set(key, '1', {
      NX: true,
      EX: ttlSeconds
    });
    return result === 'OK';
  } catch {
    logger.error('SIWE wallet auth replay protection failed');
    if (!canUseLocalNonceReplayFallback()) {
      return false;
    }
    return consumeLocalNonce(key, expiresAtMs);
  }
}

export function clearSiweWalletAuthReplayCacheForTests(): void {
  localConsumedNonceExpirations.clear();
}

function isSiweChallengeEnvelope(
  value: jwt.JwtPayload
): value is SiweChallengeEnvelope {
  const keys = Object.keys(value);
  return (
    keys.length === ENVELOPE_KEYS.size &&
    keys.every((key) => ENVELOPE_KEYS.has(key)) &&
    value.challenge_type === SIWE_CHALLENGE_TYPE &&
    value.challenge_version === SIWE_CHALLENGE_VERSION &&
    value.challenge_format === SIWE_CHALLENGE_FORMAT &&
    typeof value.message === 'string' &&
    value.client_type === 'web' &&
    typeof value.client_origin === 'string' &&
    normalizeWebAppOrigin(value.client_origin) === value.client_origin &&
    typeof value.iat === 'number' &&
    Number.isInteger(value.iat) &&
    typeof value.exp === 'number' &&
    Number.isInteger(value.exp) &&
    value.exp - value.iat === SIWE_WALLET_AUTH_TTL_SECONDS &&
    value.iss === SIWE_WALLET_AUTH_ISSUER &&
    value.sub === SIWE_WALLET_AUTH_SUBJECT &&
    typeof value.aud === 'string'
  );
}

function isSiweTimingValid(
  parsed: ParsedSiweWebAuthMessage,
  now: Date
): boolean {
  const nowMs = now.getTime();
  return (
    !Number.isNaN(nowMs) &&
    parsed.issuedAt.getTime() <=
      nowMs + SIWE_WALLET_AUTH_MAX_FUTURE_SKEW_SECONDS * 1000 &&
    parsed.expirationTime.getTime() > nowMs
  );
}

function parseCanonicalDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }
  return parsed;
}

function toWholeSecondDate(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1000) * 1000);
}

function toEpochSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function canUseLocalNonceReplayFallback(): boolean {
  return process.env.NODE_ENV === 'local' || process.env.NODE_ENV === 'test';
}

function consumeLocalNonce(key: string, expiresAtMs: number): boolean {
  const now = Date.now();
  localConsumedNonceExpirations.forEach((expirationMs, cachedKey) => {
    if (expirationMs <= now) {
      localConsumedNonceExpirations.delete(cachedKey);
    }
  });
  if ((localConsumedNonceExpirations.get(key) ?? 0) > now) {
    return false;
  }
  localConsumedNonceExpirations.set(key, expiresAtMs);
  return true;
}
