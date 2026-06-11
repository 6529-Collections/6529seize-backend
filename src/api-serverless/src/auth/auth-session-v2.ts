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
  ApiCreateConnectionTransferResponse,
  ApiCreateConnectionTransferResponseTargetClientTypeEnum
} from '../generated/models/ApiCreateConnectionTransferResponse';
import { ApiRedeemConnectionTransferResponse } from '../generated/models/ApiRedeemConnectionTransferResponse';
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
const DEFAULT_TRANSFER_CODE_TTL_SECONDS = 5 * 60;

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

export interface RedeemedConnectionTransfer {
  readonly response: ApiRedeemConnectionTransferResponse;
}

export type CreatedConnectionTransfer = ApiCreateConnectionTransferResponse;

export type ParsedSessionCookie = {
  readonly sessionId: string;
  readonly secret: string;
} | null;

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

export function isAuthSessionV2Enabled(): boolean {
  return process.env.AUTH_SESSION_V2_ENABLED === 'true';
}

export function isAuthTransferCodesEnabled(): boolean {
  return process.env.AUTH_TRANSFER_CODES_ENABLED === 'true';
}

export function isLegacyRefreshEnabled(): boolean {
  return process.env.AUTH_LEGACY_REFRESH_ENABLED !== 'false';
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
  return [
    `${WALLET_SESSION_COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/api/auth',
    'HttpOnly',
    'Secure',
    'SameSite=Lax'
  ].join('; ');
}

export async function createWebSession({
  address,
  role,
  userAgent
}: {
  readonly address: string;
  readonly role: string | null;
  readonly userAgent: string | null;
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
    expiresAt
  });
  const accessToken = issueAccessToken(session.address, session.role);
  return {
    response: toWebSessionResponse(session.address, session.role, accessToken),
    setCookie: serializeSessionCookie(sessionId, secret, expiresAt)
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
  cookie
}: {
  readonly cookie: ParsedSessionCookie;
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
    setCookie: serializeSessionCookie(rotated.id, nextSecret, expiresAt)
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
  allSessions
}: {
  readonly cookie: ParsedSessionCookie;
  readonly allSessions: boolean;
}): Promise<string> {
  if (!cookie) {
    return clearWalletSessionCookie();
  }
  const now = new Date();
  const existing = await authDb.getActiveWebSessionBySecretHash(
    cookie.sessionId,
    hashSecret(cookie.secret),
    now
  );
  if (allSessions && existing) {
    await authDb.revokeWalletAuthSessionsForAddress(existing.address, now);
  } else if (existing) {
    await authDb.revokeWalletAuthSession(existing.id, now);
  }
  return clearWalletSessionCookie();
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

export async function createConnectionTransfer({
  address,
  role,
  targetClientType
}: {
  readonly address: string;
  readonly role: string | null;
  readonly targetClientType: WalletAuthClientType;
}): Promise<CreatedConnectionTransfer> {
  assertNativeConnectionTransferTarget(targetClientType);
  const transferCode = createOpaqueSecret();
  const expiresAt = getTransferExpiresAt();
  const transfer = await authDb.createWalletConnectionTransfer({
    id: randomUUID(),
    transferCodeHash: hashSecret(transferCode),
    address: address.toLowerCase(),
    role,
    targetClientType,
    expiresAt
  });
  const queryParams = new URLSearchParams();
  queryParams.set('transfer_code', transferCode);
  queryParams.set('address', transfer.address);
  if (transfer.role) {
    queryParams.set('role', transfer.role);
  }
  return {
    transfer_code: transferCode,
    expires_at: toDate(transfer.expires_at),
    address: transfer.address,
    role: transfer.role,
    target_client_type:
      ApiCreateConnectionTransferResponseTargetClientTypeEnum.Native,
    deep_link_path: `/accept-connection-sharing?${queryParams.toString()}`
  };
}

export async function redeemConnectionTransfer({
  transferCode,
  targetClientType,
  userAgent
}: {
  readonly transferCode: string;
  readonly targetClientType: WalletAuthClientType;
  readonly userAgent: string | null;
}): Promise<RedeemedConnectionTransfer | null> {
  assertNativeConnectionTransferTarget(targetClientType);
  const session = await authDb.executeNativeQueriesInTransaction(
    async (connection) => {
      const transfer = await authDb.consumeWalletConnectionTransfer(
        {
          transferCodeHash: hashSecret(transferCode),
          targetClientType,
          now: new Date()
        },
        connection
      );
      if (!transfer) {
        return null;
      }
      const createdSession = await createNativeSessionRecord(
        {
          address: transfer.address,
          role: transfer.role,
          userAgent
        },
        connection
      );
      await authDb.markWalletConnectionTransferSession(
        transfer.id,
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

function assertNativeConnectionTransferTarget(
  targetClientType: WalletAuthClientType
): void {
  if (targetClientType !== 'native') {
    throw new BadRequestException(
      'Connection transfer codes currently support native clients only'
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

function serializeSessionCookie(
  sessionId: string,
  secret: string,
  expiresAt: Date
): string {
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  return [
    `${WALLET_SESSION_COOKIE_NAME}=${encodeURIComponent(
      `${sessionId}.${secret}`
    )}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/api/auth',
    'HttpOnly',
    'Secure',
    'SameSite=Lax'
  ].join('; ');
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

function getTransferExpiresAt(): Date {
  const seconds =
    env.getIntOrNull('AUTH_TRANSFER_CODE_TTL_SECONDS') ??
    DEFAULT_TRANSFER_CODE_TTL_SECONDS;
  return new Date(Date.now() + Time.seconds(seconds).toMillis());
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
