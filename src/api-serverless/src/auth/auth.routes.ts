import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import { env } from '@/env';
import { isWebAuthCredentialOriginAllowed } from '../api-constants';
import {
  getAuthenticatedWalletOrNull,
  getJwtSecret,
  needsAuthenticatedUser
} from './auth';
import { asyncRouter } from '../async.router';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  BadRequestException,
  UnauthorisedException
} from '../../../exceptions';
import { ApiNonceResponse } from '../generated/models/ApiNonceResponse';
import { ApiLoginRequest } from '../generated/models/ApiLoginRequest';
import { profileProxyApiService } from '../proxies/proxy.api.service';
import { ApiRedeemRefreshTokenRequest } from '../generated/models/ApiRedeemRefreshTokenRequest';
import { ApiRedeemRefreshTokenResponse } from '../generated/models/ApiRedeemRefreshTokenResponse';
import { ApiCreateConnectionShareRequest } from '../generated/models/ApiCreateConnectionShareRequest';
import { ApiCreateConnectionShareResponse } from '../generated/models/ApiCreateConnectionShareResponse';
import { ApiCreateLegacyDesktopConnectionShareRequest } from '../generated/models/ApiCreateLegacyDesktopConnectionShareRequest';
import { ApiCreateLegacyDesktopConnectionShareResponse } from '../generated/models/ApiCreateLegacyDesktopConnectionShareResponse';
import { ApiRedeemConnectionShareRequest } from '../generated/models/ApiRedeemConnectionShareRequest';
import { ApiRedeemConnectionShareResponse } from '../generated/models/ApiRedeemConnectionShareResponse';
import { ApiSessionLoginRequest } from '../generated/models/ApiSessionLoginRequest';
import { ApiSessionLogoutNativeRequest } from '../generated/models/ApiSessionLogoutNativeRequest';
import { ApiSessionLogoutWebRequest } from '../generated/models/ApiSessionLogoutWebRequest';
import { ApiSessionNonceResponse } from '../generated/models/ApiSessionNonceResponse';
import { ApiSessionRefreshNativeRequest } from '../generated/models/ApiSessionRefreshNativeRequest';
import { ApiSessionRefreshWebRequest } from '../generated/models/ApiSessionRefreshWebRequest';
import { CreateWalletAuthSession201Response } from '../generated/models/CreateWalletAuthSession201Response';
import { LogoutWalletAuthSessionRequest } from '../generated/models/LogoutWalletAuthSessionRequest';
import { RefreshWalletAuthSessionRequest } from '../generated/models/RefreshWalletAuthSessionRequest';
import { assertLegacyRefreshEnabled } from './auth-legacy-refresh';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';
import { authDb } from './auth.db';
import {
  clearWalletSessionCookieForAddressAndOrigin,
  clearWalletSessionCookieForOrigin,
  createConnectionShare,
  createNativeSession,
  createWebSession,
  hasActiveNativeSessionForAddressAndRole,
  hasActiveWebSessionForAddressAndRole,
  isAuthConnectionSharingEnabled,
  issueAccessToken,
  logoutNativeSession,
  logoutWebSession,
  redeemConnectionShare,
  refreshNativeSession,
  refreshWebSessionForAddress
} from './auth-session-v2';
import {
  buildStructuredWalletSignatureMessage,
  ETHEREUM_MAINNET_CHAIN_ID,
  getDefaultStructuredWalletSignatureAudience,
  getStructuredWalletSignatureAudienceForHost,
  isStructuredSignaturesRequired,
  isStructuredSignatureDomainAllowed,
  isStructuredWalletSignatureMessage,
  parseStructuredWalletSignatureMessage,
  verifyStructuredWalletSignature,
  verifyWalletMessageSignature
} from '../wallet-signatures/structured-wallet-signatures';
import type {
  ParsedStructuredWalletSignatureMessage,
  StructuredWalletSignatureSessionType
} from '../wallet-signatures/structured-wallet-signatures';
import type { WalletAuthClientType } from '@/entities/IWalletAuthSession';

const router = asyncRouter();

type RefreshTokenSessionClientType = Exclude<WalletAuthClientType, 'web'>;

interface NonceQueryRequest {
  signer_address: string;
  short_nonce: boolean;
}

interface SessionNonceQueryRequest {
  signer_address: string;
  client_type: WalletAuthClientType;
  chain_id: number;
}

interface ResolvedSessionNonceContext {
  readonly domain: string;
  readonly clientOrigin: string | null;
  readonly sessionType: StructuredWalletSignatureSessionType;
}

interface ConnectionShareAuthProof {
  readonly role?: string | null;
  readonly client_type?: RefreshTokenSessionClientType;
  readonly client_address?: string;
  readonly native_refresh_token?: string;
}

router.get(
  '/nonce',
  function (
    req: Request<any, any, any, NonceQueryRequest, any>,
    res: Response<ApiResponse<ApiNonceResponse>>
  ) {
    const nonceRequest = getValidatedByJoiOrThrow(
      req.query,
      NonceQueryRequestSchema
    );
    const shortNonce = nonceRequest.short_nonce;
    const signerAddress = nonceRequest.signer_address.toLowerCase();
    if (!signerAddress || !ethers.isAddress(signerAddress)) {
      throw new UnauthorisedException(
        `Invalid signer address ${signerAddress}`
      );
    }
    const nonce = shortNonce
      ? randomUUID()
      : `
Are you ready to Seize The Memes of Production?

Please sign to confirm ownership of this address to allow use of the social features of 6529.io.

The signature does not generate a blockchain transaction, cost gas, or give any token approvals. 

Your use of the site is subject to the TOS (https://www.6529.io/tos) and Privacy (https://6529.io/privacy) policies.

Wallet Address That You Are Verifying
${signerAddress}

Nonce (Unique Identifier)
${randomUUID()}`;
    const serverSignature = jwt.sign(nonce, getJwtSecret());
    res.status(200).send({
      nonce,
      server_signature: serverSignature
    });
  }
);

router.get(
  '/session-nonce',
  function (
    req: Request<any, any, any, SessionNonceQueryRequest, any>,
    res: Response<ApiResponse<ApiSessionNonceResponse>>
  ) {
    const nonceRequest = getValidatedByJoiOrThrow(
      req.query,
      SessionNonceQueryRequestSchema
    );
    const signerAddress = nonceRequest.signer_address.toLowerCase();
    if (!signerAddress || !ethers.isAddress(signerAddress)) {
      throw new UnauthorisedException(
        `Invalid signer address ${signerAddress}`
      );
    }
    const nonceContext = resolveSessionNonceContext(req, nonceRequest);
    const audience =
      getStructuredWalletSignatureAudienceForHost(req.headers.host) ??
      getDefaultStructuredWalletSignatureAudience();
    const authWalletChainId = getAuthWalletChainId();
    const signableMessage = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      audience,
      domain: nonceContext.domain,
      clientOrigin: nonceContext.clientOrigin,
      sessionType: nonceContext.sessionType,
      wallet: signerAddress,
      chainId: authWalletChainId,
      nonce: randomUUID(),
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const serverSignature = jwt.sign(signableMessage, getJwtSecret());
    res.status(200).send({
      signable_message: signableMessage,
      server_signature: serverSignature
    });
  }
);

router.post(
  `/login`,
  async function (
    req: Request<any, any, ApiLoginRequest, any, any>,
    res: Response<ApiResponse<ApiLoginResponse>>
  ) {
    const timer = Timer.getFromRequest(req);
    const loginRequest = getValidatedByJoiOrThrow(req.body, LoginRequestSchema);
    const { server_signature, client_signature, role, client_address } =
      loginRequest;
    try {
      const nonce = verifyServerSignature(server_signature);
      const signingAddress = await verifyClientSignature(
        nonce,
        client_signature,
        client_address ?? null
      );
      const chosenRole = await resolveAuthenticatedRole(
        signingAddress,
        role ?? null,
        timer
      );
      const accessToken = issueAccessToken(signingAddress, chosenRole).token;
      const refreshToken = await authDb.retrieveOrGenerateRefreshToken(
        signingAddress,
        chosenRole
      );
      res.status(201).send({
        token: accessToken,
        refresh_token: refreshToken
      });
    } catch (err: any) {
      throw new UnauthorisedException(`Authentication failed: ${err.message}`);
    }
  }
);

router.post(
  '/session-login',
  async function (
    req: Request<any, any, ApiSessionLoginRequest, any, any>,
    res: Response<ApiResponse<CreateWalletAuthSession201Response>>
  ) {
    const timer = Timer.getFromRequest(req);
    const loginRequest = getValidatedByJoiOrThrow(
      req.body,
      SessionLoginRequestSchema
    );
    try {
      const nonce = verifyServerSignature(loginRequest.server_signature);
      const signingAddress = await verifyClientSignature(
        nonce,
        loginRequest.client_signature,
        loginRequest.client_address
      );
      const chosenRole = await resolveAuthenticatedRole(
        signingAddress,
        loginRequest.role ?? null,
        timer
      );
      if (isRefreshTokenSessionClientType(loginRequest.client_type)) {
        const parsedMessage = assertSessionLoginSignatureType(
          nonce,
          loginRequest.client_type
        );
        if (loginRequest.client_type === 'desktop') {
          assertDesktopSessionOriginAllowed(req, parsedMessage);
        }
        const created = await createNativeSession({
          address: signingAddress,
          role: chosenRole,
          userAgent: getUserAgent(req),
          clientType: loginRequest.client_type
        });
        res.status(201).send(created.response);
        return;
      }
      const parsedMessage = assertSessionLoginSignatureType(nonce, 'web');
      if (!parsedMessage.clientOrigin) {
        throw new BadRequestException(
          'Wallet auth web sessions require a client origin'
        );
      }
      assertWebAuthCredentialOriginAllowed(
        parsedMessage.clientOrigin,
        req.headers.host
      );
      assertSessionOriginMatchesRequest(req, parsedMessage.clientOrigin);
      const created = await createWebSession({
        address: signingAddress,
        role: chosenRole,
        userAgent: getUserAgent(req),
        signatureDomain: parsedMessage.domain,
        clientOrigin: parsedMessage.clientOrigin,
        apiHost: req.headers.host
      });
      res.setHeader('Set-Cookie', created.setCookie);
      res.status(201).send(created.response);
    } catch (err: any) {
      throw new UnauthorisedException(`Authentication failed: ${err.message}`);
    }
  }
);

router.post(
  '/session-refresh',
  async function (
    req: Request<
      any,
      any,
      RefreshWalletAuthSessionRequest | undefined,
      any,
      any
    >,
    res: Response<ApiResponse<CreateWalletAuthSession201Response>>
  ) {
    const body = req.body ?? {};
    const clientType = getSessionClientType(body);
    if (isRefreshTokenSessionClientType(clientType)) {
      const refreshRequest = getValidatedByJoiOrThrow(
        body,
        SessionRefreshNativeRequestSchema
      );
      const refreshed = await refreshNativeSession({
        address: refreshRequest.client_address,
        nativeRefreshToken: refreshRequest.native_refresh_token,
        clientType
      });
      if (!refreshed) {
        throw new UnauthorisedException('Invalid session');
      }
      res.status(201).send(refreshed.response);
      return;
    }
    const refreshRequest = getValidatedByJoiOrThrow(
      { ...body, client_type: 'web' },
      SessionRefreshWebRequestSchema
    );
    assertWebSessionRequestOriginAllowed(req);
    const requestOrigin = getNormalizedRequestOrigin(req);
    const refreshed = await refreshWebSessionForAddress({
      cookieHeader: req.headers.cookie,
      address: refreshRequest.client_address ?? null,
      requestOrigin,
      apiHost: req.headers.host
    });
    if (!refreshed) {
      res.setHeader(
        'Set-Cookie',
        refreshRequest.client_address
          ? clearWalletSessionCookieForAddressAndOrigin({
              address: refreshRequest.client_address,
              clientOrigin: requestOrigin,
              apiHost: req.headers.host,
              includeCompatibilityCookie: false
            })
          : clearWalletSessionCookieForOrigin({
              clientOrigin: requestOrigin,
              apiHost: req.headers.host
            })
      );
      throw new UnauthorisedException('Invalid session');
    }
    res.setHeader('Set-Cookie', refreshed.setCookie);
    res.status(201).send(refreshed.response);
  }
);

router.post(
  '/session-logout',
  async function (
    req: Request<
      any,
      any,
      LogoutWalletAuthSessionRequest | undefined,
      any,
      any
    >,
    res: Response<void>
  ) {
    const body = req.body ?? {};
    const clientType = getSessionClientType(body);
    if (isRefreshTokenSessionClientType(clientType)) {
      const logoutRequest = getValidatedByJoiOrThrow(
        body,
        SessionLogoutNativeRequestSchema
      );
      await logoutNativeSession({
        address: logoutRequest.client_address,
        nativeRefreshToken: logoutRequest.native_refresh_token,
        allSessions: logoutRequest.all_sessions ?? false,
        clientType
      });
      res.status(204).send();
      return;
    }
    const logoutRequest = getValidatedByJoiOrThrow(
      { ...body, client_type: 'web' },
      SessionLogoutWebRequestSchema
    );
    assertWebSessionRequestOriginAllowed(req);
    const setCookie = await logoutWebSession({
      cookieHeader: req.headers.cookie,
      address: logoutRequest.client_address ?? null,
      allSessions: logoutRequest.all_sessions ?? false,
      requestOrigin: getNormalizedRequestOrigin(req),
      apiHost: req.headers.host
    });
    res.setHeader('Set-Cookie', setCookie);
    res.status(204).send();
  }
);

router.post(
  '/connection-share',
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiCreateConnectionShareRequest, any, any>,
    res: Response<ApiResponse<ApiCreateConnectionShareResponse>>
  ) {
    assertConnectionSharingEnabled();
    const shareRequest = getValidatedByJoiOrThrow(
      req.body,
      CreateConnectionShareRequestSchema
    );
    const { authenticatedWallet, authRole } =
      await getAuthenticatedConnectionShareContext(req, shareRequest);
    const created = await createConnectionShare({
      address: authenticatedWallet,
      role: authRole,
      targetClientType: shareRequest.target_client_type
    });
    res.status(201).send(created);
  }
);

router.post(
  '/connection-share/legacy-desktop',
  needsAuthenticatedUser(),
  async function (
    req: Request<
      any,
      any,
      ApiCreateLegacyDesktopConnectionShareRequest | undefined,
      any,
      any
    >,
    res: Response<ApiResponse<ApiCreateLegacyDesktopConnectionShareResponse>>
  ) {
    assertConnectionSharingEnabled();
    assertLegacyRefreshEnabled();
    const legacyShareRequest = getValidatedByJoiOrThrow(
      req.body ?? {},
      CreateLegacyDesktopConnectionShareRequestSchema
    );
    const { authenticatedWallet, authRole } =
      await getAuthenticatedConnectionShareContext(req, legacyShareRequest);
    const refreshToken = await authDb.retrieveOrGenerateRefreshToken(
      authenticatedWallet,
      authRole
    );
    const queryParams = new URLSearchParams({
      token: refreshToken,
      address: authenticatedWallet
    });
    if (authRole) {
      queryParams.set('role', authRole);
    }
    res.status(201).send({
      refresh_token: refreshToken,
      address: authenticatedWallet,
      role: authRole,
      deep_link_path: `/accept-connection-sharing?${queryParams.toString()}`
    });
  }
);

router.post(
  '/connection-share/redeem',
  async function (
    req: Request<any, any, ApiRedeemConnectionShareRequest, any, any>,
    res: Response<ApiResponse<ApiRedeemConnectionShareResponse>>
  ) {
    assertConnectionSharingEnabled();
    const redeemRequest = getValidatedByJoiOrThrow(
      req.body,
      RedeemConnectionShareRequestSchema
    );
    const redeemed = await redeemConnectionShare({
      connectionShareCode: redeemRequest.connection_share_code,
      targetClientType: redeemRequest.target_client_type,
      userAgent: getUserAgent(req)
    });
    if (!redeemed) {
      throw new UnauthorisedException('Invalid connection share code');
    }
    res.status(201).send(redeemed.response);
  }
);

router.post(
  '/redeem-refresh-token',
  async function (
    req: Request<any, any, ApiRedeemRefreshTokenRequest, any, any>,
    res: Response<ApiResponse<ApiRedeemRefreshTokenResponse>>
  ) {
    assertLegacyRefreshEnabled();
    const tokenAddress = req.body.address?.toLowerCase();
    const refreshToken = req.body.token;
    const role = req.body.role ?? null;
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }
    const redeemedAddress = await authDb.redeemRefreshToken(
      tokenAddress,
      refreshToken
    );
    if (!redeemedAddress) {
      throw new BadRequestException('Invalid refresh token');
    }
    const refreshRole = await resolveLegacyRefreshRole({
      redeemedAddress: redeemedAddress.address,
      storedRole: redeemedAddress.role,
      requestedRole: role,
      refreshToken,
      timer: Timer.getFromRequest(req)
    });
    const accessToken = issueAccessToken(
      redeemedAddress.address,
      refreshRole
    ).token;
    res.status(201).send({
      address: redeemedAddress.address,
      token: accessToken
    });
  }
);

function assertConnectionSharingEnabled(): void {
  if (!isAuthConnectionSharingEnabled()) {
    throw new BadRequestException('Wallet auth connection sharing is disabled');
  }
}

function getSessionClientType(body: {
  readonly client_type?: unknown;
}): WalletAuthClientType {
  if (body.client_type == null) {
    return 'web';
  }
  if (
    body.client_type === 'web' ||
    body.client_type === 'native' ||
    body.client_type === 'desktop'
  ) {
    return body.client_type;
  }
  throw new BadRequestException('client_type must be web, native, or desktop');
}

function isRefreshTokenSessionClientType(
  clientType: WalletAuthClientType
): clientType is RefreshTokenSessionClientType {
  return clientType === 'native' || clientType === 'desktop';
}

async function resolveAuthenticatedRole(
  signingAddress: string,
  role: string | null,
  timer: Timer
): Promise<string | null> {
  const signingProfile = await identityFetcher.getProfileIdByIdentityKey(
    { identityKey: signingAddress },
    { timer }
  );
  let chosenRole = role;
  if (signingProfile == null) {
    if (role) {
      throw new BadRequestException(
        `You need to create a profile before you can choose a role`
      );
    }
  } else if (!role) {
    chosenRole = signingProfile;
  } else {
    const roleId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: role },
      {}
    );
    if (!roleId) {
      throw new BadRequestException(`Role ${role} not found`);
    }
    const proxy = await profileProxyApiService.getProxyByGrantedByAndGrantedTo({
      granted_to_profile_id: signingProfile,
      granted_by_profile_id: roleId
    });
    if (proxy === null) {
      throw new BadRequestException(
        `Profile ${role} hasn't created a proxy for you, so you can't authenticate as this role.`
      );
    }
    chosenRole = roleId;
  }
  return chosenRole ?? null;
}

async function resolveLegacyRefreshRole({
  redeemedAddress,
  storedRole,
  requestedRole,
  refreshToken,
  timer
}: {
  readonly redeemedAddress: string;
  readonly storedRole: string | null;
  readonly requestedRole: string | null;
  readonly refreshToken: string;
  readonly timer: Timer;
}): Promise<string | null> {
  if (storedRole) {
    if (requestedRole) {
      if (requestedRole === storedRole) {
        return storedRole;
      }
      const resolvedRequestedRole = await resolveAuthenticatedRole(
        redeemedAddress,
        requestedRole,
        timer
      );
      if (resolvedRequestedRole !== storedRole) {
        throw new BadRequestException(
          'Refresh token role does not match requested role'
        );
      }
    }
    return storedRole;
  }

  if (!requestedRole) {
    return null;
  }

  const resolvedRole = await resolveAuthenticatedRole(
    redeemedAddress,
    requestedRole,
    timer
  );
  if (!resolvedRole) {
    return null;
  }
  const bound = await authDb.bindUnboundRefreshTokenRole(
    redeemedAddress,
    refreshToken,
    resolvedRole
  );
  if (!bound) {
    throw new BadRequestException('Refresh token role could not be bound');
  }
  return resolvedRole;
}

function verifyServerSignature(serverSignature: string): string {
  const nonce = jwt.verify(serverSignature, getJwtSecret());
  if (!nonce || typeof nonce !== 'string') {
    throw new Error(`Invalid server signature ${serverSignature}`);
  }
  return nonce;
}

async function verifyClientSignature(
  nonce: string,
  clientSignature: string,
  clientAddress: string | null
): Promise<string> {
  clientAddress = clientAddress?.toLowerCase() ?? null;
  if (isStructuredWalletSignatureMessage(nonce)) {
    if (!clientAddress) {
      throw new BadRequestException(
        `client_address is mandatory in structured signatures`
      );
    }
    const parsedMessage = parseStructuredWalletSignatureMessage(nonce);
    if (!parsedMessage) {
      throw new Error('Invalid structured signature message');
    }
    const signingAddress = await verifyStructuredWalletSignature({
      message: nonce,
      signature: clientSignature,
      expectedAddress: clientAddress,
      expectedChainId: getAuthWalletChainId(),
      expectedAction: 'login',
      expectedKind: 'authentication',
      requireAllowedDomain: parsedMessage.sessionType === 'first_party_web'
    });
    if (!signingAddress) {
      throw new Error('Invalid client signature');
    }
    return signingAddress;
  }

  if (isStructuredSignaturesRequired()) {
    throw new Error('Structured wallet signature required');
  }

  const signingAddress = await verifyWalletMessageSignature({
    message: nonce,
    signature: clientSignature,
    expectedAddress: clientAddress,
    chainId: ETHEREUM_MAINNET_CHAIN_ID
  });
  if (!signingAddress) {
    throw new Error('Invalid client signature');
  }
  return signingAddress;
}

function getAuthWalletChainId(): number {
  const chainId =
    env.getIntOrNull('AUTH_WALLET_CHAIN_ID') ?? ETHEREUM_MAINNET_CHAIN_ID;
  if (!Number.isInteger(chainId) || chainId < 1) {
    throw new Error('AUTH_WALLET_CHAIN_ID must be a positive integer');
  }
  return chainId;
}

function assertSessionLoginSignatureType(
  nonce: string,
  clientType: WalletAuthClientType
): ParsedStructuredWalletSignatureMessage {
  const expectedSessionType = getStructuredSessionTypeForClientType(clientType);
  if (!isStructuredWalletSignatureMessage(nonce)) {
    throw new BadRequestException(
      'Wallet auth sessions require a structured signature'
    );
  }
  const parsedMessage = parseStructuredWalletSignatureMessage(nonce);
  if (parsedMessage?.sessionType !== expectedSessionType) {
    throw new BadRequestException(
      `Wallet auth ${clientType} sessions require a ${expectedSessionType} structured signature`
    );
  }
  return parsedMessage;
}

function getStructuredSessionTypeForClientType(
  clientType: WalletAuthClientType
): StructuredWalletSignatureSessionType {
  if (clientType === 'web') {
    return 'first_party_web';
  }
  return clientType;
}

function getUserAgent(req: Request<any, any, any, any, any>): string | null {
  const value = req.headers['user-agent'];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((it) => it.trim().length > 0) ?? null;
  }
  return null;
}

function getRequestOrigin(
  req: Request<any, any, any, any, any>
): string | null {
  const value = req.headers.origin;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.find((it) => it.trim().length > 0) ?? null;
  }
  return null;
}

function getNormalizedRequestOrigin(
  req: Request<any, any, any, any, any>
): string | null {
  return normalizeOrigin(getRequestOrigin(req));
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const origin = new URL(value.trim().toLowerCase()).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host;
  } catch {
    return null;
  }
}

export function isDesktopSessionOriginAllowed(
  origin: string | null | undefined
): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  try {
    const url = new URL(normalizedOrigin);
    return (
      url.protocol === 'http:' &&
      !!url.port &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '::1' ||
        url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function resolveSessionNonceContext(
  req: Request<any, any, any, any, any>,
  nonceRequest: SessionNonceQueryRequest
): ResolvedSessionNonceContext {
  if (nonceRequest.client_type === 'native') {
    return {
      domain: nonceRequest.client_type,
      clientOrigin: null,
      sessionType: nonceRequest.client_type
    };
  }
  if (nonceRequest.client_type === 'desktop') {
    const requestOrigin = getNormalizedRequestOrigin(req);
    if (!isDesktopSessionOriginAllowed(requestOrigin)) {
      throw new BadRequestException(
        'Wallet auth desktop sessions require a localhost Origin'
      );
    }
    const domain = normalizeDomain(requestOrigin);
    if (!domain) {
      throw new BadRequestException(
        'Wallet auth desktop sessions require a valid localhost Origin'
      );
    }
    return {
      domain,
      clientOrigin: requestOrigin,
      sessionType: 'desktop'
    };
  }

  const requestOrigin = getNormalizedRequestOrigin(req);
  if (!requestOrigin) {
    throw new BadRequestException(
      'Wallet auth web sessions require an Origin header'
    );
  }
  const domain = normalizeDomain(requestOrigin);
  if (!domain) {
    throw new BadRequestException(
      'Wallet auth web sessions require a valid Origin header'
    );
  }
  if (!isStructuredSignatureDomainAllowed(domain)) {
    throw new BadRequestException(
      'Wallet auth web sessions require a first-party Origin'
    );
  }
  assertWebAuthCredentialOriginAllowed(requestOrigin, req.headers.host);
  return {
    domain,
    clientOrigin: requestOrigin,
    sessionType: 'first_party_web'
  };
}

function assertDesktopSessionOriginAllowed(
  req: Request<any, any, any, any, any>,
  parsedMessage: ParsedStructuredWalletSignatureMessage
): void {
  const signedClientOrigin = parsedMessage.clientOrigin;
  if (
    !signedClientOrigin ||
    !isDesktopSessionOriginAllowed(signedClientOrigin)
  ) {
    throw new BadRequestException(
      'Wallet auth desktop sessions require a localhost Origin'
    );
  }

  const expectedDomain = normalizeDomain(signedClientOrigin);
  if (!expectedDomain || parsedMessage.domain !== expectedDomain) {
    throw new BadRequestException(
      'Wallet auth desktop session domain does not match the signed Origin'
    );
  }

  const requestOrigin = getNormalizedRequestOrigin(req);
  if (requestOrigin && requestOrigin !== signedClientOrigin) {
    throw new BadRequestException(
      'Wallet auth desktop session Origin does not match the signed challenge'
    );
  }
}

function assertSessionOriginMatchesRequest(
  req: Request<any, any, any, any, any>,
  signedClientOrigin: string
): void {
  const requestOrigin = getNormalizedRequestOrigin(req);
  assertWebAuthCredentialOriginAllowed(requestOrigin, req.headers.host);
  if (!requestOrigin || requestOrigin !== signedClientOrigin) {
    throw new BadRequestException(
      'Wallet auth web session Origin does not match the signed challenge'
    );
  }
}

function assertWebSessionRequestOriginAllowed(
  req: Request<any, any, any, any, any>
): void {
  assertWebAuthCredentialOriginAllowed(
    getNormalizedRequestOrigin(req),
    req.headers.host
  );
}

function assertWebAuthCredentialOriginAllowed(
  origin: string | null | undefined,
  apiHostHeader: unknown
): void {
  if (!origin || !isWebAuthCredentialOriginAllowed(origin, apiHostHeader)) {
    throw new BadRequestException(
      'Wallet auth web session Origin is not allowed'
    );
  }
}

async function getAuthenticatedConnectionShareContext(
  req: Request<any, any, any, any, any>,
  shareRequest: ConnectionShareAuthProof
): Promise<{
  readonly authenticatedWallet: string;
  readonly authRole: string | null;
}> {
  const authenticatedWallet = getAuthenticatedWalletOrNull(req)?.toLowerCase();
  if (!authenticatedWallet) {
    throw new UnauthorisedException('Authentication required');
  }
  const authRole = ((req.user as any)?.role ?? null) as string | null;
  if (shareRequest.role !== undefined && shareRequest.role !== authRole) {
    throw new BadRequestException(
      'Share role must match authenticated session role'
    );
  }

  if (shareRequest.client_type) {
    if (
      !shareRequest.client_address ||
      !shareRequest.native_refresh_token ||
      shareRequest.client_address.toLowerCase() !== authenticatedWallet
    ) {
      throw new BadRequestException(
        'Share source session must match authenticated wallet'
      );
    }

    const hasActiveMatchingNativeSession =
      await hasActiveNativeSessionForAddressAndRole({
        address: authenticatedWallet,
        role: authRole,
        nativeRefreshToken: shareRequest.native_refresh_token,
        clientType: shareRequest.client_type
      });
    if (!hasActiveMatchingNativeSession) {
      throw new UnauthorisedException(
        'Connection sharing requires an active session-v2 native session'
      );
    }
    return { authenticatedWallet, authRole };
  }

  const hasActiveMatchingWebSession =
    await hasActiveWebSessionForAddressAndRole({
      cookieHeader: req.headers.cookie,
      address: authenticatedWallet,
      role: authRole,
      requestOrigin: getNormalizedRequestOrigin(req)
    });
  if (!hasActiveMatchingWebSession) {
    throw new UnauthorisedException(
      'Connection sharing requires an active session-v2 web session'
    );
  }
  return { authenticatedWallet, authRole };
}

const LoginRequestSchema: Joi.ObjectSchema<ApiLoginRequest> =
  Joi.object<ApiLoginRequest>({
    server_signature: Joi.string().required(),
    client_signature: Joi.string().required(),
    role: Joi.string().optional(),
    client_address: Joi.string().optional().allow(null).default(null),
    is_safe_wallet: Joi.boolean().optional().default(false)
  });

const NonceQueryRequestSchema: Joi.ObjectSchema<NonceQueryRequest> =
  Joi.object<NonceQueryRequest>({
    signer_address: Joi.string().required(),
    short_nonce: Joi.boolean()
      .truthy('true')
      .falsy('false')
      .optional()
      .default(false)
  }).unknown(false);

const SessionNonceQueryRequestSchema: Joi.ObjectSchema<SessionNonceQueryRequest> =
  Joi.object<SessionNonceQueryRequest>({
    signer_address: Joi.string().required(),
    client_type: Joi.string()
      .valid('web', 'native', 'desktop')
      .optional()
      .default('web'),
    chain_id: Joi.number().integer().min(1).optional().default(1)
  }).unknown(false);

const ClientTypeSchema = Joi.string().valid('web', 'native', 'desktop');

const SessionLoginRequestSchema: Joi.ObjectSchema<ApiSessionLoginRequest> =
  Joi.object<ApiSessionLoginRequest>({
    client_type: ClientTypeSchema.required(),
    server_signature: Joi.string().required(),
    client_signature: Joi.string().required(),
    role: Joi.string().optional().allow(null).default(null),
    client_address: Joi.string().required(),
    wallet_kind_hint: Joi.string()
      .valid('eoa', 'contract', 'unknown')
      .optional()
      .allow(null),
    signature_version: Joi.number().integer().valid(1, 2).optional().default(2)
  }).unknown(false);

const SessionRefreshWebRequestSchema: Joi.ObjectSchema<ApiSessionRefreshWebRequest> =
  Joi.object<ApiSessionRefreshWebRequest>({
    client_type: Joi.string().valid('web').required(),
    client_address: Joi.string().optional().allow(null)
  }).unknown(false);

const SessionRefreshNativeRequestSchema: Joi.ObjectSchema<ApiSessionRefreshNativeRequest> =
  Joi.object<ApiSessionRefreshNativeRequest>({
    client_type: Joi.string().valid('native', 'desktop').required(),
    client_address: Joi.string().required(),
    native_refresh_token: Joi.string().hex().length(128).required()
  }).unknown(false);

const SessionLogoutWebRequestSchema: Joi.ObjectSchema<ApiSessionLogoutWebRequest> =
  Joi.object<ApiSessionLogoutWebRequest>({
    client_type: Joi.string().valid('web').required(),
    client_address: Joi.string().optional().allow(null),
    all_sessions: Joi.boolean().optional().default(false)
  }).unknown(false);

const SessionLogoutNativeRequestSchema: Joi.ObjectSchema<ApiSessionLogoutNativeRequest> =
  Joi.object<ApiSessionLogoutNativeRequest>({
    client_type: Joi.string().valid('native', 'desktop').required(),
    client_address: Joi.string().required(),
    native_refresh_token: Joi.string().hex().length(128).required(),
    all_sessions: Joi.boolean().optional().default(false)
  }).unknown(false);

const CreateConnectionShareRequestSchema: Joi.ObjectSchema<ApiCreateConnectionShareRequest> =
  Joi.object<ApiCreateConnectionShareRequest>({
    target_client_type: Joi.string().valid('native', 'desktop').required(),
    role: Joi.string().optional().allow(null),
    client_type: Joi.string().valid('native', 'desktop').optional(),
    client_address: Joi.string().optional(),
    native_refresh_token: Joi.string().hex().length(128).optional()
  })
    .and('client_type', 'client_address', 'native_refresh_token')
    .unknown(false);

const CreateLegacyDesktopConnectionShareRequestSchema: Joi.ObjectSchema<ApiCreateLegacyDesktopConnectionShareRequest> =
  Joi.object<ApiCreateLegacyDesktopConnectionShareRequest>({
    role: Joi.string().optional().allow(null),
    client_type: Joi.string().valid('native', 'desktop').optional(),
    client_address: Joi.string().optional(),
    native_refresh_token: Joi.string().hex().length(128).optional()
  })
    .and('client_type', 'client_address', 'native_refresh_token')
    .unknown(false);

const RedeemConnectionShareRequestSchema: Joi.ObjectSchema<ApiRedeemConnectionShareRequest> =
  Joi.object<ApiRedeemConnectionShareRequest>({
    connection_share_code: Joi.string().hex().length(64).required(),
    target_client_type: Joi.string().valid('native', 'desktop').required()
  }).unknown(false);

interface ApiLoginResponse {
  readonly token: string;
  readonly refresh_token: string;
}

export default router;
