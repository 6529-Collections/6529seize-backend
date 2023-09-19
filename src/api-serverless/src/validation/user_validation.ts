import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { areEqualAddresses, isValidUrl } from '../../../helpers';
import { User } from '../../../entities/IUser';

const rememeSchema = Joi.object({
  wallet: Joi.string().required(),
  signature: Joi.string().required(),
  user: {
    pfp: Joi.string().allow(null).required(),
    banner_1: Joi.string().allow(null).required(),
    banner_2: Joi.string().allow(null).required(),
    website: Joi.string().allow(null).required()
  }
});

export async function validateUser(req: any, res: any, next: any) {
  console.log('[VALIDATE USER]', `[VALIDATING...]`);

  const body = req.body;

  if (!body) {
    req.validatedBody = {
      valid: false,
      error: 'Empty request body'
    };
  } else {
    const { error, value } = rememeSchema.validate(body);

    if (error) {
      req.validatedBody = {
        valid: false,
        error: error.message
      };
    } else {
      const signatureValidation = validateSignature(
        value.wallet,
        value.signature,
        value.user
      );

      if (!signatureValidation) {
        req.validatedBody = {
          valid: false,
          error: 'Invalid signature'
        };
      } else {
        const user: User = {
          created_at: new Date(),
          wallet: value.wallet,
          pfp: isValidUrl(value.user.pfp) ? value.user.pfp : null,
          banner_1: value.user.banner_1,
          banner_2: value.user.banner_2,
          website: value.user.website
        };

        req.validatedBody = {
          valid: true,
          user: user
        };
      }
    }
  }

  next();
}

function validateSignature(
  address: string,
  signature: string,
  user: {
    pfp: string;
    banner_1: string;
    banner_2: string;
    website: string;
  }
) {
  try {
    const verifySigner = ethers.utils.recoverAddress(
      hashMessage(JSON.stringify(user)),
      signature
    );
    return areEqualAddresses(address, verifySigner);
  } catch (e) {
    console.log('error', e);
    return false;
  }
}
