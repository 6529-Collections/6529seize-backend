import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { env } from '@/env';
import { BadRequestException } from '@/exceptions';
import { WalletAuthClientType } from '@/entities/IWalletAuthSession';
import { ConnectionWrapper } from '@/sql-executor';
import { Time } from '@/time';
import { getJwtExpiry, getJwtSecret } from './auth';
import { authDb } from './auth.db';
import {
  ApiCreateConnectionShareResponse,
  ApiCreateConnectionShareResponseTargetClientTypeEnum
} from '../generated/models/ApiCreateConnectionShareResponse';
import { ApiRedeemConnectionShareResponse } from '../generated/models/ApiRedeemConnectionShareResponse';
import {
  ApiSessionNativeResponse,
  ApiSessionNativeResponseClientTypeEnum
} from '../generated/models/ApiSessionNativeResponse';
import {
  ApiSessionWebResponse,
  ApiSessionWebResponseClientTypeEnum
} from '../generated/models/ApiSessionWebResponse';

export const WALLET_SESSION_COOKIE_NAME = '6529_session';

const DEFAULT_SESSION_REFRESH_DAYS = 30;
const DEFAULT_CONNECTION_SHARE_CODE_TTL_SECONDS = 5 * 60;

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export type SessionV2WebResponse = ApiSessionWebResponse;

export type SessionV2NativeResponse = ApiSessionNativeResponse;

export interface CreatedWebSession {
  readonly response: SessionV2WebResponse;
  readonly setCookie: string;
}

export interface CreatedNativeSession {
  readonly response: SessionV2NativeResponse;
}

export interface RedeemedConnectionShare {
  readonly response: ApiRedeemConnectionShareResponse;
}

export type CreatedConnectionShare = ApiCreateConnectionShareResponse;

export type ParsedSessionCookie = {
  readonly sessionId: string;
  readonly secret: string;
} | null;

export interface ActiveWebSession {
  readonly address: string;
  readonly role: string | null;
}

type AuthDbConnection = ConnectionWrapper<any>;

export function issueAccessToken(
  address: string,
  role?: string | null
): IssuedAccessToken {
  const expiresInSeconds = getJwtExpiry();
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = jwt.sign(
    {
      id: randomUUID(),
      sub: address.toLowerCase(),
      ...(role ? { role } : {})
    },
    getJwtSecret(),
    {
      expiresIn: expiresInSeconds
    }
  );
  return { token, expiresAt };
}

export function isAuthConnectionSharingEnabled(): boolean {
  return process.env.AUTH_CONNECTION_SHARING_DISABLED !== 'true';
}

export function isLegacyWsQueryTokenEnabled(): boolean {
  return process.env.AUTH_LEGACY_WS_QUERY_TOKEN_ENABLED !== 'false';
}

export function parseWalletSessionCookieHeader(
  cookieHeader: string | undefined
): ParsedSessionCookie {
  if (!cookieHeader) {
    return null;
  }
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.split('=');
    const name = rawName?.trim();
    if (name !== WALLET_SESSION_COOKIE_NAME) {
      continue;
    }
    const rawValue = rawValueParts.join('=').trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      return null;
    }
    const [sessionId, secret] = decoded.split('.');
    if (
      !sessionId ||
      !secret ||
      sessionId.trim().length === 0 ||
      secret.trim().length === 0
    ) {
      return null;
    }
    return { sessionId, secret };
  }
  return null;
}

export function clearWalletSessionCookie(): string {
  return clearWalletSessionCookieForOrigin({
    clientOrigin: null,
    apiHost: null
  });
}

export function clearWalletSessionCookieForOrigin({
  clientOrigin,
  apiHost
}: {
  readonly clientOrigin: string | null;
  readonly apiHost: unknown;
}): string {
  return serializeCookieAttributes({
    maxAge: 0,
    sameSite: getSessionCookieSameSite(clientOrigin, apiHost)
  });
}

export async function createWebSession({
  address,
  role,
  userAgent,
  signatureDomain,
  clientOrigin,
  apiHost
}: {
  readonly address: string;
  readonly role: string | null;
  readonly userAgent: string | null;
  readonly signatureDomain: string;
  readonly clientOrigin: string;
  readonly apiHost: unknown;
}): Promise<CreatedWebSession> {
  const sessionId = randomUUID();
  const secret = createOpaqueSecret();
  const secretHash = hashSecret(secret);
  const expiresAt = getSessionRefreshExpiresAt();
  const session = await authDb.createWalletAuthSession({
    id: sessionId,
    address: address.toLowerCase(),
    role,
    clientType: 'web',
    secretHash,
    refreshTokenHash: null,
    userAgentHash: userAgent ? hashPublicValue(userAgent) : null,
    signatureDomain,
    clientOrigin,
    expiresAt
  });
  const accessToken = issueAccessToken(session.address, session.role);
  return {
    response: toWebSessionResponse(session.address, session.role, accessToken),
    setCookie: serializeSessionCookie({
      sessionId,
      secret,
      expiresAt,
      clientOrigin,
      apiHost
    })
  };
}

export async function createNativeSession({
  address,
  role,
  userAgent
}: {
  readonly address: string;
  readonly role: string | null;
  readonly userAgent: string | null;
}): Promise<CreatedNativeSession> {
  const session = await createNativeSessionRecord({
    address,
    role,
    userAgent
  });
  return { response: session.response };
}

export async function refreshWebSession({
  cookie,
  requestOrigin,
  apiHost
}: {
  readonly cookie: ParsedSessionCookie;
  readonly requestOrigin: string | null;
  readonly apiHost: unknown;
}): Promise<CreatedWebSession | null> {
  if (!cookie) {
    return null;
  }
  const now = new Date();
  const existing = await authDb.getActiveWebSessionBySecretHash(
    cookie.sessionId,
    hashSecret(cookie.secret),
    now
  );
  if (!existing) {
    return null;
  }
  if (!isMatchingSessionOrigin(existing.client_origin, requestOrigin)) {
    return null;
  }
  const nextSecret = createOpaqueSecret();
  const expiresAt = getSessionRefreshExpiresAt();
  const rotated = await authDb.rotateWebSessionSecret({
    sessionId: existing.id,
    previousSecretHash: hashSecret(cookie.secret),
    nextSecretHash: hashSecret(nextSecret),
    expiresAt,
    now
  });
  if (!rotated) {
    return null;
  }
  const accessToken = issueAccessToken(rotated.address, rotated.role);
  return {
    response: toWebSessionResponse(rotated.address, rotated.role, accessToken),
    setCookie: serializeSessionCookie({
      sessionId: rotated.id,
      secret: nextSecret,
      expiresAt,
      clientOrigin: existing.client_origin,
      apiHost
    })
  };
}

export async function getActiveWebSession({
  cookie,
  requestOrigin
}: {
  readonly cookie: ParsedSessionCookie;
  readonly requestOrigin: string | null;
}): Promise<ActiveWebSession | null> {
  if (!cookie) {
    return null;
  }
  const existing = await authDb.getActiveWebSessionBySecretHash(
    cookie.sessionId,
    hashSecret(cookie.secret),
    new Date()
  );
  if (!existing) {
    return null;
  }
  if (!isMatchingSessionOrigin(existing.client_origin, requestOrigin)) {
    return null;
  }
  return {
    address: existing.address.toLowerCase(),
    role: existing.role ?? null
  };
}

export async function refreshNativeSession({
  address,
  nativeRefreshToken
}: {
  readonly address: string;
  readonly nativeRefreshToken: string;
}): Promise<CreatedNativeSession | null> {
  const now = new Date();
  const existing = await authDb.getActiveNativeSessionByRefreshHash(
    address.toLowerCase(),
    hashSecret(nativeRefreshToken),
    now
  );
  if (!existing) {
    return null;
  }
  const nextRefreshToken = createOpaqueSecret(64);
  const expiresAt = getSessionRefreshExpiresAt();
  const rotated = await authDb.rotateNativeSessionRefreshToken({
    sessionId: existing.id,
    previousRefreshTokenHash: hashSecret(nativeRefreshToken),
    nextRefreshTokenHash: hashSecret(nextRefreshToken),
    expiresAt,
    now
  });
  if (!rotated) {
    return null;
  }
  const accessToken = issueAccessToken(rotated.address, rotated.role);
  return {
    response: {
      address: rotated.address,
      role: rotated.role,
      access_token: accessToken.token,
      access_token_expires_at: accessToken.expiresAt,
      client_type: ApiSessionNativeResponseClientTypeEnum.Native,
      native_refresh_token: nextRefreshToken,
      refresh_token_expires_at: expiresAt
    }
  };
}

export async function logoutWebSession({
  cookie,
  allSessions,
  requestOrigin,
  apiHost
}: {
  readonly cookie: ParsedSessionCookie;
  readonly allSessions: boolean;
  readonly requestOrigin: string | null;
  readonly apiHost: unknown;
}): Promise<string> {
  if (!cookie) {
    return clearWalletSessionCookieForOrigin({
      clientOrigin: requestOrigin,
      apiHost
    });
  }
  const now = new Date();
  const existing = await authDb.getActiveWebSessionBySecretHash(
    cookie.sessionId,
    hashSecret(cookie.secret),
    now
  );
  if (
    existing &&
    !isMatchingSessionOrigin(existing.client_origin, requestOrigin)
  ) {
    return clearWalletSessionCookieForOrigin({
      clientOrigin: requestOrigin,
      apiHost
    });
  }
  if (allSessions && existing) {
    await authDb.revokeWalletAuthSessionsForAddress(existing.address, now);
  } else if (existing) {
    await authDb.revokeWalletAuthSession(existing.id, now);
  }
  return clearWalletSessionCookieForOrigin({
    clientOrigin: existing?.client_origin ?? requestOrigin,
    apiHost
  });
}

export async function logoutNativeSession({
  address,
  nativeRefreshToken,
  allSessions
}: {
  readonly address: string;
  readonly nativeRefreshToken: string;
  readonly allSessions: boolean;
}): Promise<void> {
  const now = new Date();
  const refreshTokenHash = hashSecret(nativeRefreshToken);
  if (allSessions) {
    const existing = await authDb.getActiveNativeSessionByRefreshHash(
      address.toLowerCase(),
      refreshTokenHash,
      now
    );
    if (existing) {
      await authDb.revokeWalletAuthSessionsForAddress(existing.address, now);
    }
    return;
  }
  await authDb.revokeWalletAuthSessionByRefreshHash(refreshTokenHash, now);
}

export async function createConnectionShare({
  address,
  role,
  targetClientType
}: {
  readonly address: string;
  readonly role: string | null;
  readonly targetClientType: WalletAuthClientType;
}): Promise<CreatedConnectionShare> {
  assertNativeConnectionShareTarget(targetClientType);
  const connectionShareCode = createOpaqueSecret();
  const expiresAt = getConnectionShareExpiresAt();
  const share = await authDb.createWalletConnectionShare({
    id: randomUUID(),
    connectionShareCodeHash: hashSecret(connectionShareCode),
    address: address.toLowerCase(),
    role,
    targetClientType,
    expiresAt
  });
  const queryParams = new URLSearchParams();
  queryParams.set('connection_share_code', connectionShareCode);
  queryParams.set('address', share.address);
  return {
    connection_share_code: connectionShareCode,
    expires_at: toDate(share.expires_at),
    address: share.address,
    role: share.role,
    target_client_type:
      ApiCreateConnectionShareResponseTargetClientTypeEnum.Native,
    deep_link_path: `/accept-connection-sharing?${queryParams.toString()}`
  };
}

export async function redeemConnectionShare({
  connectionShareCode,
  targetClientType,
  userAgent
}: {
  readonly connectionShareCode: string;
  readonly targetClientType: WalletAuthClientType;
  readonly userAgent: string | null;
}): Promise<RedeemedConnectionShare | null> {
  assertNativeConnectionShareTarget(targetClientType);
  const session = await authDb.executeNativeQueriesInTransaction(
    async (connection) => {
      const share = await authDb.consumeWalletConnectionShare(
        {
          connectionShareCodeHash: hashSecret(connectionShareCode),
          targetClientType,
          now: new Date()
        },
        connection
      );
      if (!share) {
        return null;
      }
      const createdSession = await createNativeSessionRecord(
        {
          address: share.address,
          role: share.role,
          userAgent
        },
        connection
      );
      await authDb.markWalletConnectionShareSession(
        share.id,
        createdSession.sessionId,
        connection
      );
      return createdSession;
    }
  );
  if (!session) {
    return null;
  }
  return {
    response: {
      address: session.response.address,
      role: session.response.role,
      access_token: session.response.access_token,
      access_token_expires_at: session.response.access_token_expires_at,
      native_refresh_token: session.response.native_refresh_token,
      refresh_token_expires_at: session.response.refresh_token_expires_at
    }
  };
}

function assertNativeConnectionShareTarget(
  targetClientType: WalletAuthClientType
): void {
  if (targetClientType !== 'native') {
    throw new BadRequestException(
      'Connection share codes currently support native clients only'
    );
  }
}

function toWebSessionResponse(
  address: string,
  role: string | null,
  accessToken: IssuedAccessToken
): SessionV2WebResponse {
  return {
    address,
    role,
    access_token: accessToken.token,
    access_token_expires_at: accessToken.expiresAt,
    client_type: ApiSessionWebResponseClientTypeEnum.Web
  };
}

async function createNativeSessionRecord(
  {
    address,
    role,
    userAgent
  }: {
    readonly address: string;
    readonly role: string | null;
    readonly userAgent: string | null;
  },
  connection?: AuthDbConnection
): Promise<CreatedNativeSession & { readonly sessionId: string }> {
  const sessionId = randomUUID();
  const nativeRefreshToken = createOpaqueSecret(64);
  const expiresAt = getSessionRefreshExpiresAt();
  const session = await authDb.createWalletAuthSession(
    {
      id: sessionId,
      address: address.toLowerCase(),
      role,
      clientType: 'native',
      secretHash: null,
      refreshTokenHash: hashSecret(nativeRefreshToken),
      userAgentHash: userAgent ? hashPublicValue(userAgent) : null,
      signatureDomain: null,
      clientOrigin: null,
      expiresAt
    },
    connection
  );
  const accessToken = issueAccessToken(session.address, session.role);
  return {
    sessionId,
    response: {
      address: session.address,
      role: session.role,
      access_token: accessToken.token,
      access_token_expires_at: accessToken.expiresAt,
      client_type: ApiSessionNativeResponseClientTypeEnum.Native,
      native_refresh_token: nativeRefreshToken,
      refresh_token_expires_at: expiresAt
    }
  };
}

function serializeSessionCookie({
  sessionId,
  secret,
  expiresAt,
  clientOrigin,
  apiHost
}: {
  readonly sessionId: string;
  readonly secret: string;
  readonly expiresAt: Date;
  readonly clientOrigin: string | null;
  readonly apiHost: unknown;
}): string {
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  return [
    `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent(
      `${sessionId}.${secret}`
    )}`,
    `Max-Age=${maxAgeSeconds}`,
    ...getBaseCookieAttributes(getSessionCookieSameSite(clientOrigin, apiHost))
  ].join('; ');
}

function serializeCookieAttributes({
  maxAge,
  sameSite
}: {
  readonly maxAge: number;
  readonly sameSite: 'Lax' | 'None';
}): string {
  return [
    `${WALLET_SESSION_COOKIE_NAME}=`,
    `Max-Age=${maxAge}`,
    ...getBaseCookieAttributes(sameSite)
  ].join('; ');
}

function getBaseCookieAttributes(sameSite: 'Lax' | 'None'): string[] {
  return ['Path=/api/auth', 'HttpOnly', 'Secure', `SameSite=${sameSite}`];
}

function getSessionCookieSameSite(
  clientOrigin: string | null,
  apiHost: unknown
): 'Lax' | 'None' {
  if (!clientOrigin || !isCrossSiteOrigin(clientOrigin, apiHost)) {
    return 'Lax';
  }
  return 'None';
}

function isCrossSiteOrigin(clientOrigin: string, apiHost: unknown): boolean {
  const clientSite = getSiteKeyFromOrigin(clientOrigin);
  const apiSite = getSiteKeyFromApiHost(apiHost);
  return !!clientSite && !!apiSite && clientSite !== apiSite;
}

function getSiteKeyFromOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    return `${parsed.protocol}//${getApproximateRegistrableDomain(
      parsed.hostname
    )}`;
  } catch {
    return null;
  }
}

function getSiteKeyFromApiHost(apiHost: unknown): string | null {
  if (typeof apiHost !== 'string' || !apiHost.trim()) {
    return null;
  }
  try {
    const rawHost = apiHost.trim().toLowerCase();
    const parsed = new URL(
      rawHost.includes('://') ? rawHost : `https://${rawHost}`
    );
    return `${parsed.protocol}//${getApproximateRegistrableDomain(
      parsed.hostname
    )}`;
  } catch {
    return null;
  }
}

function getApproximateRegistrableDomain(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host;
  }
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

function isMatchingSessionOrigin(
  storedOrigin: string | null,
  requestOrigin: string | null
): boolean {
  return !!storedOrigin && !!requestOrigin && storedOrigin === requestOrigin;
}

function createOpaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function hashSecret(secret: string): string {
  return createHmac('sha256', getSessionHashSecret())
    .update(secret, 'utf8')
    .digest('hex');
}

function hashPublicValue(value: string): string {
  return createHmac('sha256', getSessionHashSecret())
    .update(value, 'utf8')
    .digest('hex');
}

function getSessionHashSecret(): string {
  return env.getStringOrNull('AUTH_SESSION_HASH_SECRET') ?? getJwtSecret();
}

function getSessionRefreshExpiresAt(): Date {
  const days =
    env.getIntOrNull('AUTH_SESSION_V2_REFRESH_DAYS') ??
    DEFAULT_SESSION_REFRESH_DAYS;
  return new Date(Date.now() + Time.days(days).toMillis());
}

function getConnectionShareExpiresAt(): Date {
  const seconds =
    env.getIntOrNull('AUTH_CONNECTION_SHARE_CODE_TTL_SECONDS') ??
    DEFAULT_CONNECTION_SHARE_CODE_TTL_SECONDS;
  return new Date(Date.now() + Time.seconds(seconds).toMillis());
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
