import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import {
  getAuthenticationContext,
  getJwtExpiry,
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
import { profilesService } from '../../../profiles/profiles.service';
import { profileProxyApiService } from '../proxies/proxy.api.service';

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
    if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
      throw new UnauthorisedException(
        `Invalid signer address ${signerAddress}`
      );
    }
    const nonce = shortNonce
      ? randomUUID()
      : `
Are you ready to Seize The Memes of Production?

Please sign to confirm ownership of this address to allow use of the social features of Seize.io.

The signature does not generate a blockchain transaction, cost gas, or give any token approvals. 

Your use of the site is subject to the TOS (https://www.seize.io/tos) and Privacy (https://seize.io/privacy) policies.

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
    const loginRequest = getValidatedByJoiOrThrow(req.body, LoginRequestSchema);
    const { server_signature, client_signature, role } = loginRequest;
    try {
      const nonce = verifyServerSignature(server_signature);
      const signingAddress = verifyClientSignature(nonce, client_signature);
      const signingProfile = await profilesService
        .getProfileByWallet(signingAddress)
        .then((profile) => profile?.profile?.external_id ?? null);
      let chosenRole = role;
      if (signingProfile == null) {
        if (role) {
          throw new BadRequestException(
            `You need to create a profile before you can choose a role`
          );
        }
      } else if (!chosenRole) {
        chosenRole = signingProfile;
      } else {
        const roleId = await profilesService
          .getProfileAndConsolidationsByIdentity(role)
          .then((profile) => profile?.profile?.external_id ?? null);
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
      const refreshToken = await profilesService.retrieveOrGenerateRefreshToken(
        signingAddress
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

router.post('/redeem-refresh-token', async (req: Request, res: Response) => {
  const refreshToken = req.body.token;
  const address = await profilesService.redeemRefreshToken(refreshToken);
  if (address === null) {
    throw new BadRequestException('Invalid refresh token');
  }
  const accessToken = getAccessToken(address, address);
  res.status(201).send({
    address,
    token: accessToken
  });
});

function getAccessToken(address: string, role: string) {
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

function verifyClientSignature(nonce: string, clientSignature: string): string {
  const signingAddress = ethers.utils
    .verifyMessage(nonce, clientSignature)
    ?.toLowerCase();
  if (!signingAddress) {
    throw new Error('Invalid client signature');
  }
  return signingAddress;
}

const LoginRequestSchema: Joi.ObjectSchema<ApiLoginRequest> =
  Joi.object<ApiLoginRequest>({
    server_signature: Joi.string().required(),
    client_signature: Joi.string().required(),
    role: Joi.string().optional()
  });

interface ApiLoginResponse {
  readonly token: string;
  readonly refresh_token: string;
}

export default router;
