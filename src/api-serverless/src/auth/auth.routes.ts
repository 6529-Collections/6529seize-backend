import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import { getJwtExpiry, getJwtSecret } from './auth';
import { asyncRouter } from '../async.router';
import { getValidatedByJoiOrThrow } from '../validation';
import { UnauthorisedException } from '../../../exceptions';

const router = asyncRouter();

router.get(
  '/nonce',
  function (
    req: Request<any, any, any, { signerAddress: string }, any>,
    res: Response<ApiResponse<ApiNonceresponse>>
  ) {
    const signerAddress = req.query.signerAddress?.toLocaleLowerCase();
    if (!signerAddress || !ethers.utils.isAddress(signerAddress)) {
      throw new UnauthorisedException(
        `Invalid signer address ${signerAddress}`
      );
    }
    const nonce = `
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
      serverSignature
    });
  }
);

router.post(
  `/login`,
  async function (
    req: Request<ApiLoginRequest, any, any, any, any>,
    res: Response<ApiResponse<ApiLoginResponse>>
  ) {
    const loginRequest = getValidatedByJoiOrThrow(req.body, LoginRequestSchema);
    const { serverSignature, clientSignature } = loginRequest;
    try {
      const nonce = verifyServerSignature(serverSignature);
      const signingAddress = verifyClientSignature(nonce, clientSignature);
      const token = jwt.sign(
        {
          id: randomUUID(),
          sub: signingAddress.toLowerCase()
        },
        getJwtSecret(),
        {
          expiresIn: getJwtExpiry()
        }
      );
      res.status(201).send({
        token
      });
    } catch (err: any) {
      throw new UnauthorisedException(`Authentication failed: ${err.message}`);
    }
  }
);

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

interface ApiNonceresponse {
  serverSignature: string;
  nonce: string;
}

interface ApiLoginRequest {
  readonly serverSignature: string;
  readonly clientSignature: string;
}

const LoginRequestSchema = Joi.object<ApiLoginRequest>({
  serverSignature: Joi.string().required(),
  clientSignature: Joi.string().required()
});

interface ApiLoginResponse {
  readonly token: string;
}

export default router;
