import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import { getJwtExpiry, getJwtSecret } from './auth';
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
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';
import { authDb } from './auth.db';
import { env } from '../../../env';

const router = asyncRouter();

router.get(
  '/nonce',
  function (
    req: Request<
      any,
      any,
      any,
      { signer_address: string; short_nonce?: string },
      any
    >,
    res: Response<ApiResponse<ApiNonceResponse>>
  ) {
    const shortNonce = req.query.short_nonce?.toLowerCase() === 'true';
    const signerAddress = req.query.signer_address?.toLocaleLowerCase();
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
        const proxy =
          await profileProxyApiService.getProxyByGrantedByAndGrantedTo({
            granted_to_profile_id: signingProfile,
            granted_by_profile_id: roleId
          });
        if (proxy === null) {
          throw new BadRequestException(
            `Profile ${role} hasn't creared a proxy for you, so you can't authenticated as this role.`
          );
        }
        chosenRole = roleId;
      }
      const accessToken = getAccessToken(signingAddress, chosenRole);
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
  '/redeem-refresh-token',
  async function (
    req: Request<any, any, ApiRedeemRefreshTokenRequest, any, any>,
    res: Response<ApiResponse<ApiRedeemRefreshTokenResponse>>
  ) {
    const tokenAddress = req.body.address?.toLowerCase();
    const refreshToken = req.body.token;
    const role = req.body.role;
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }
    const redeemed = await authDb.redeemRefreshToken(
      tokenAddress,
      refreshToken
    );
    if (!redeemed) {
      throw new BadRequestException('Invalid refresh token');
    }
    const accessToken = getAccessToken(tokenAddress, role);
    res.status(201).send({
      address: tokenAddress,
      token: accessToken
    });
  }
);

function getAccessToken(address: string, role?: string) {
  return jwt.sign(
    {
      id: randomUUID(),
      sub: address.toLowerCase(),
      role
    },
    getJwtSecret(),
    {
      expiresIn: getJwtExpiry()
    }
  );
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
  if (isSafeWallet) {
    if (!clientAddress) {
      throw new BadRequestException(
        `client_address is mandatory in safe signatures`
      );
    }
    const messageHash = ethers.hashMessage(nonce); // returns bytes32

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

const LoginRequestSchema: Joi.ObjectSchema<ApiLoginRequest> =
  Joi.object<ApiLoginRequest>({
    server_signature: Joi.string().required(),
    client_signature: Joi.string().required(),
    role: Joi.string().optional(),
    client_address: Joi.string().optional().allow(null).default(null),
    is_safe_wallet: Joi.boolean().optional().default(false)
  });

interface ApiLoginResponse {
  readonly token: string;
  readonly refresh_token: string;
}

export default router;
