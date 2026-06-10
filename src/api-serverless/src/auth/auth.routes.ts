import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
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
import { ApiCreateConnectionTransferRequest } from '../generated/models/ApiCreateConnectionTransferRequest';
import { ApiCreateConnectionTransferResponse } from '../generated/models/ApiCreateConnectionTransferResponse';
import { ApiRedeemConnectionTransferRequest } from '../generated/models/ApiRedeemConnectionTransferRequest';
import { ApiRedeemConnectionTransferResponse } from '../generated/models/ApiRedeemConnectionTransferResponse';
import { ApiSessionLoginRequest } from '../generated/models/ApiSessionLoginRequest';
import { ApiSessionLogoutNativeRequest } from '../generated/models/ApiSessionLogoutNativeRequest';
import { ApiSessionLogoutWebRequest } from '../generated/models/ApiSessionLogoutWebRequest';
import { ApiSessionRefreshNativeRequest } from '../generated/models/ApiSessionRefreshNativeRequest';
import { ApiSessionRefreshWebRequest } from '../generated/models/ApiSessionRefreshWebRequest';
import { CreateWalletAuthSession201Response } from '../generated/models/CreateWalletAuthSession201Response';
import { LogoutWalletAuthSessionRequest } from '../generated/models/LogoutWalletAuthSessionRequest';
import { RefreshWalletAuthSessionRequest } from '../generated/models/RefreshWalletAuthSessionRequest';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';
import { authDb } from './auth.db';
import { env } from '../../../env';
import {
  clearWalletSessionCookie,
  createConnectionTransfer,
  createNativeSession,
  createWebSession,
  isAuthSessionV2Enabled,
  isAuthTransferCodesEnabled,
  isLegacyRefreshEnabled,
  issueAccessToken,
  logoutNativeSession,
  logoutWebSession,
  parseWalletSessionCookieHeader,
  redeemConnectionTransfer,
  refreshNativeSession,
  refreshWebSession
} from './auth-session-v2';
import {
  buildStructuredWalletSignatureMessage,
  isStructuredSignaturesRequired,
  isStructuredWalletSignatureMessage,
  parseStructuredWalletSignatureMessage,
  verifyStructuredWalletSignature
} from '../wallet-signatures/structured-wallet-signatures';

const router = asyncRouter();

interface NonceQueryRequest {
  signer_address: string;
  short_nonce: boolean;
  structured_signature: boolean;
  domain?: string;
  chain_id: number;
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
    const structuredSignature = nonceRequest.structured_signature;
    const signerAddress = nonceRequest.signer_address.toLowerCase();
    if (!signerAddress || !ethers.isAddress(signerAddress)) {
      throw new UnauthorisedException(
        `Invalid signer address ${signerAddress}`
      );
    }
    if (
      structuredSignature &&
      (!nonceRequest.domain || nonceRequest.domain.trim().length === 0)
    ) {
      throw new BadRequestException(`Signature domain is required`);
    }
    const nonce = structuredSignature
      ? buildStructuredWalletSignatureMessage({
          kind: 'authentication',
          domain: nonceRequest.domain ?? '',
          wallet: signerAddress,
          chainId: nonceRequest.chain_id,
          nonce: randomUUID(),
          action: 'login',
          purpose: 'Sign this message to authenticate with 6529.'
        })
      : shortNonce
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

router.post(
  `/login`,
  async function (
    req: Request<any, any, ApiLoginRequest, any, any>,
    res: Response<ApiResponse<ApiLoginResponse>>
  ) {
    const timer = Timer.getFromRequest(req);
    const loginRequest = getValidatedByJoiOrThrow(req.body, LoginRequestSchema);
    const {
      server_signature,
      client_signature,
      role,
      client_address,
      is_safe_wallet
    } = loginRequest;
    try {
      const nonce = verifyServerSignature(server_signature);
      const signingAddress = await verifyClientSignature(
        nonce,
        client_signature,
        client_address ?? null,
        is_safe_wallet
      );
      const chosenRole = await resolveAuthenticatedRole(
        signingAddress,
        role ?? null,
        timer
      );
      const accessToken = issueAccessToken(signingAddress, chosenRole).token;
      const refreshToken =
        await authDb.retrieveOrGenerateRefreshToken(signingAddress);
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
    assertSessionV2Enabled();
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
        loginRequest.client_address,
        loginRequest.is_safe_wallet
      );
      const chosenRole = await resolveAuthenticatedRole(
        signingAddress,
        loginRequest.role ?? null,
        timer
      );
      if (loginRequest.client_type === 'native') {
        const created = await createNativeSession({
          address: signingAddress,
          role: chosenRole,
          userAgent: getUserAgent(req)
        });
        res.status(201).send(created.response);
        return;
      }
      const created = await createWebSession({
        address: signingAddress,
        role: chosenRole,
        userAgent: getUserAgent(req)
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
    assertSessionV2Enabled();
    const body = req.body ?? {};
    const clientType = getSessionClientType(body);
    if (clientType === 'native') {
      const refreshRequest = getValidatedByJoiOrThrow(
        body,
        SessionRefreshNativeRequestSchema
      );
      const refreshed = await refreshNativeSession({
        address: refreshRequest.client_address,
        nativeRefreshToken: refreshRequest.native_refresh_token
      });
      if (!refreshed) {
        throw new UnauthorisedException('Invalid session');
      }
      res.status(201).send(refreshed.response);
      return;
    }
    getValidatedByJoiOrThrow(
      { ...body, client_type: 'web' },
      SessionRefreshWebRequestSchema
    );
    const cookie = parseWalletSessionCookieHeader(req.headers.cookie);
    const refreshed = await refreshWebSession({ cookie });
    if (!refreshed) {
      res.setHeader('Set-Cookie', clearWalletSessionCookie());
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
    assertSessionV2Enabled();
    const body = req.body ?? {};
    const clientType = getSessionClientType(body);
    if (clientType === 'native') {
      const logoutRequest = getValidatedByJoiOrThrow(
        body,
        SessionLogoutNativeRequestSchema
      );
      await logoutNativeSession({
        address: logoutRequest.client_address,
        nativeRefreshToken: logoutRequest.native_refresh_token,
        allSessions: logoutRequest.all_sessions ?? false
      });
      res.status(204).send();
      return;
    }
    const logoutRequest = getValidatedByJoiOrThrow(
      { ...body, client_type: 'web' },
      SessionLogoutWebRequestSchema
    );
    const setCookie = await logoutWebSession({
      cookie: parseWalletSessionCookieHeader(req.headers.cookie),
      allSessions: logoutRequest.all_sessions ?? false
    });
    res.setHeader('Set-Cookie', setCookie);
    res.status(204).send();
  }
);

router.post(
  '/connection-transfer',
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiCreateConnectionTransferRequest, any, any>,
    res: Response<ApiResponse<ApiCreateConnectionTransferResponse>>
  ) {
    assertSessionV2Enabled();
    assertTransferCodesEnabled();
    const transferRequest = getValidatedByJoiOrThrow(
      req.body,
      CreateConnectionTransferRequestSchema
    );
    const authenticatedWallet = getAuthenticatedWalletOrNull(req);
    if (!authenticatedWallet) {
      throw new UnauthorisedException('Authentication required');
    }
    const authRole = ((req.user as any)?.role ?? null) as string | null;
    if (transferRequest.role && transferRequest.role !== authRole) {
      throw new BadRequestException(
        'Transfer role must match authenticated session role'
      );
    }
    const created = await createConnectionTransfer({
      address: authenticatedWallet,
      role: authRole,
      targetClientType: transferRequest.target_client_type
    });
    res.status(201).send(created);
  }
);

router.post(
  '/connection-transfer/redeem',
  async function (
    req: Request<any, any, ApiRedeemConnectionTransferRequest, any, any>,
    res: Response<ApiResponse<ApiRedeemConnectionTransferResponse>>
  ) {
    assertSessionV2Enabled();
    assertTransferCodesEnabled();
    const redeemRequest = getValidatedByJoiOrThrow(
      req.body,
      RedeemConnectionTransferRequestSchema
    );
    const redeemed = await redeemConnectionTransfer({
      transferCode: redeemRequest.transfer_code,
      targetClientType: redeemRequest.target_client_type,
      userAgent: getUserAgent(req)
    });
    if (!redeemed) {
      throw new UnauthorisedException('Invalid transfer code');
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
    if (!isLegacyRefreshEnabled()) {
      throw new BadRequestException('Legacy refresh token auth is disabled');
    }
    const tokenAddress = req.body.address?.toLowerCase();
    const refreshToken = req.body.token;
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
    const accessToken = issueAccessToken(redeemedAddress).token;
    res.status(201).send({
      address: redeemedAddress,
      token: accessToken
    });
  }
);

function assertSessionV2Enabled(): void {
  if (!isAuthSessionV2Enabled()) {
    throw new BadRequestException('Wallet auth session v2 is disabled');
  }
}

function assertTransferCodesEnabled(): void {
  if (!isAuthTransferCodesEnabled()) {
    throw new BadRequestException('Wallet auth transfer codes are disabled');
  }
}

function getSessionClientType(body: {
  readonly client_type?: unknown;
}): 'web' | 'native' {
  if (body.client_type == null) {
    return 'web';
  }
  if (body.client_type === 'web' || body.client_type === 'native') {
    return body.client_type;
  }
  throw new BadRequestException('client_type must be either web or native');
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
  clientAddress: string | null,
  isSafeWallet: boolean
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
      expectedChainId: parsedMessage.chainId,
      expectedAction: 'login',
      expectedKind: 'authentication',
      isContractWalletHint: isSafeWallet
    });
    if (!signingAddress) {
      throw new Error('Invalid client signature');
    }
    return signingAddress;
  }

  if (isStructuredSignaturesRequired()) {
    throw new Error('Structured wallet signature required');
  }

  if (isSafeWallet) {
    if (!clientAddress) {
      throw new BadRequestException(
        `client_address is mandatory in safe signatures`
      );
    }
    const messageHash = ethers.hashMessage(nonce);

    const EIP1271_ABI = [
      'function isValidSignature(bytes32 _messageHash, bytes _signature) public view returns (bytes4)'
    ];

    const provider = new ethers.JsonRpcProvider(
      `https://eth-mainnet.alchemyapi.io/v2/${env.getStringOrThrow(`ALCHEMY_API_KEY`)}`
    );
    const safeContract = new ethers.Contract(
      clientAddress,
      EIP1271_ABI,
      provider
    );
    const result = await safeContract.isValidSignature(
      messageHash,
      clientSignature
    );
    const MAGIC_VALUE = '0x1626ba7e';

    if (result === MAGIC_VALUE) {
      return clientAddress;
    } else {
      throw new Error('Invalid client signature');
    }
  } else {
    const signingAddress = ethers
      .verifyMessage(nonce, clientSignature)
      ?.toLowerCase();
    if (
      !signingAddress ||
      (clientAddress && signingAddress !== clientAddress)
    ) {
      throw new Error('Invalid client signature');
    }
    return signingAddress;
  }
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
      .default(false),
    structured_signature: Joi.boolean()
      .truthy('true')
      .falsy('false')
      .optional()
      .default(false),
    domain: Joi.string().trim().optional(),
    chain_id: Joi.number().integer().min(1).optional().default(1)
  }).unknown(false);

const ClientTypeSchema = Joi.string().valid('web', 'native');

const SessionLoginRequestSchema: Joi.ObjectSchema<ApiSessionLoginRequest> =
  Joi.object<ApiSessionLoginRequest>({
    client_type: ClientTypeSchema.required(),
    server_signature: Joi.string().required(),
    client_signature: Joi.string().required(),
    role: Joi.string().optional().allow(null).default(null),
    client_address: Joi.string().required(),
    is_safe_wallet: Joi.boolean().required(),
    wallet_kind_hint: Joi.string()
      .valid('eoa', 'contract', 'unknown')
      .optional()
      .allow(null),
    version: Joi.number().integer().optional()
  });

const SessionRefreshWebRequestSchema: Joi.ObjectSchema<ApiSessionRefreshWebRequest> =
  Joi.object<ApiSessionRefreshWebRequest>({
    client_type: Joi.string().valid('web').required()
  }).unknown(false);

const SessionRefreshNativeRequestSchema: Joi.ObjectSchema<ApiSessionRefreshNativeRequest> =
  Joi.object<ApiSessionRefreshNativeRequest>({
    client_type: Joi.string().valid('native').required(),
    client_address: Joi.string().required(),
    native_refresh_token: Joi.string().hex().length(128).required()
  }).unknown(false);

const SessionLogoutWebRequestSchema: Joi.ObjectSchema<ApiSessionLogoutWebRequest> =
  Joi.object<ApiSessionLogoutWebRequest>({
    client_type: Joi.string().valid('web').required(),
    all_sessions: Joi.boolean().optional().default(false)
  }).unknown(false);

const SessionLogoutNativeRequestSchema: Joi.ObjectSchema<ApiSessionLogoutNativeRequest> =
  Joi.object<ApiSessionLogoutNativeRequest>({
    client_type: Joi.string().valid('native').required(),
    client_address: Joi.string().required(),
    native_refresh_token: Joi.string().hex().length(128).required(),
    all_sessions: Joi.boolean().optional().default(false)
  });

const CreateConnectionTransferRequestSchema: Joi.ObjectSchema<ApiCreateConnectionTransferRequest> =
  Joi.object<ApiCreateConnectionTransferRequest>({
    target_client_type: Joi.string().valid('native').required(),
    role: Joi.string().optional().allow(null)
  });

const RedeemConnectionTransferRequestSchema: Joi.ObjectSchema<ApiRedeemConnectionTransferRequest> =
  Joi.object<ApiRedeemConnectionTransferRequest>({
    transfer_code: Joi.string().hex().length(64).required(),
    target_client_type: Joi.string().valid('native').required()
  });

interface ApiLoginResponse {
  readonly token: string;
  readonly refresh_token: string;
}

export default router;
