import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException } from '@/exceptions';
import {
  issueScopedAccessToken,
  ScopedAccessToken
} from './auth-session-v2';
import {
  CommunityAppAuthDb,
  CreateDeviceCodeParams
} from './community-app-auth.db';

const DEVICE_CODE_TTL_SECONDS = 5 * 60; // 5 min (same as connection share)
const PKCE_METHOD = 'S256';
const USER_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const USER_CODE_LENGTH = 8;

export interface CreateDeviceAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
}

export interface DeviceCodeResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: Date;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly expiresIn: number;
}

export interface ApprovalResult {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientDescription: string;
  readonly redirectUri: string;
  readonly scope: string;
}

export interface TokenExchangeResult {
  readonly accessToken: ScopedAccessToken;
  readonly address: string;
  readonly role: string | null;
  readonly clientId: string;
  readonly scope: string;
}

export async function createDeviceAuthorization(
  input: CreateDeviceAuthorizationInput,
  db: CommunityAppAuthDb
): Promise<DeviceCodeResult> {
  // Validate client exists and is active
  const client = await db.getActiveClient(input.clientId);
  if (!client) {
    throw new BadRequestException('Unknown or inactive community app client');
  }

  // Validate redirect_uri is in allowlist
  const allowedUris: string[] = JSON.parse(client.allowed_redirect_uris);
  if (!allowedUris.includes(input.redirectUri)) {
    throw new BadRequestException('Redirect URI not allowed for this client');
  }

  // Validate scopes are subset of allowed
  const requestedScopes = input.scope.split(' ').filter(Boolean);
  const allowedScopes = client.allowed_scopes.split(',').map((s) => s.trim());
  const invalidScopes = requestedScopes.filter(
    (s) => !allowedScopes.includes(s)
  );
  if (invalidScopes.length > 0) {
    throw new BadRequestException(
      `Scope(s) not allowed: ${invalidScopes.join(', ')}`
    );
  }

  // Validate PKCE
  if (input.codeChallengeMethod !== PKCE_METHOD) {
    throw new BadRequestException('Only S256 PKCE method is supported');
  }

  const deviceCode = createOpaqueSecret();
  const userCode = createUserCode();
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

  await db.createDeviceCode({
    id: randomUUID(),
    deviceCodeHash: hashSecret(deviceCode),
    userCodeHash: hashSecret(userCode),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    pkceCodeChallenge: input.codeChallenge,
    pkceCodeChallengeMethod: input.codeChallengeMethod,
    expiresAt
  });

  return {
    deviceCode,
    userCode,
    expiresAt,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scope: input.scope,
    expiresIn: DEVICE_CODE_TTL_SECONDS
  };
}

export async function approveDeviceAuthorization(
  userCode: string,
  address: string,
  role: string | null,
  db: CommunityAppAuthDb
): Promise<ApprovalResult | null> {
  const userCodeHash = hashSecret(userCode);
  const code = await db.findPendingDeviceCodeByUserCode(userCodeHash);
  if (!code) return null;

  const client = await db.getActiveClient(code.client_id);
  if (!client) return null;

  const approved = await db.executeNativeQueriesInTransaction(async (connection) => {
    return db.approveDeviceCode(code.id, address, role, connection);
  });
  if (!approved) return null;

  return {
    clientId: client.client_id,
    clientName: client.name,
    clientDescription: client.description,
    redirectUri: code.redirect_uri,
    scope: code.scope
  };
}

export async function exchangeDeviceCodeForToken(
  input: { readonly deviceCode: string; readonly codeVerifier: string },
  db: CommunityAppAuthDb
): Promise<TokenExchangeResult | null> {
  const deviceCodeHash = hashSecret(input.deviceCode);

  const code = await db.executeNativeQueriesInTransaction(async (connection) => {
    return db.consumeDeviceCode(deviceCodeHash, connection);
  });
  if (!code) return null;

  // Verify PKCE
  const expectedChallenge = createHash('sha256')
    .update(input.codeVerifier)
    .digest('base64url');
  if (code.pkce_code_challenge !== expectedChallenge) {
    throw new BadRequestException('PKCE verification failed');
  }

  const accessToken = issueScopedAccessToken({
    sub: code.approved_by_address!,
    aud: code.client_id,
    scope: code.scope,
    role: code.approved_by_role
  });

  return {
    accessToken,
    address: code.approved_by_address!,
    role: code.approved_by_role,
    clientId: code.client_id,
    scope: code.scope
  };
}

function createUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_CHARS[Math.floor(Math.random() * USER_CODE_CHARS.length)];
  }
  return code;
}

function createOpaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}