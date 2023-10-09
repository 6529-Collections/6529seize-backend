import { Request, Response, Router } from 'express';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ApiResponse } from './api-response';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import { getJwtExpiry, getJwtSecret } from './auth';

const router = Router();

router.get(
  '/nonce',
  function (
    _: Request<any, any, any, any, any>,
    res: Response<ApiResponse<ApiNonceresponse>>
  ) {
    const nonce = randomUUID();
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
    const { error, value: loginRequest } = LoginRequestSchema.validate(
      req.body
    );
    if (error) {
      console.error(
        `[API] [AUTH] Invalid login request: ${JSON.stringify(req.body)}`,
        error
      );
      res.status(401).send({ error: error.message }).end();
      return;
    }
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
      console.log(
        `[API] [AUTH] Login successful for ${signingAddress}. Released a new JWT`
      );
      res.status(201).send({
        token
      });
    } catch (err) {
      console.error(
        `[API] [AUTH] Invalid login request: ${JSON.stringify(req.body)}`,
        err
      );
      res.status(401).send({ error: `Authentication failed` });
    } finally {
      res.end();
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
