import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { areEqualAddresses, isValidUrl } from '../../../helpers';
import { User } from '../../../entities/IUser';
import { fetchMemesLite } from '../../../db-api';
import { persistS3 } from './s3';

const path = require('path');

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

const userSchema = Joi.object({
  wallet: Joi.string().required(),
  signature: Joi.string().required(),
  user: {
    pfp: Joi.string().allow(null).required(),
    meme: Joi.number().allow(null).required(),
    banner_1: Joi.string().allow(null).required(),
    banner_2: Joi.string().allow(null).required(),
    website: Joi.string().allow(null).required()
  }
});

export async function validateUser(req: any, res: any, next: any) {
  console.log('[VALIDATE USER]', `[VALIDATING...]`);

  const body = req.body;
  const file = req.file;

  if (!body) {
    req.validatedBody = {
      valid: false,
      error: 'Empty request body'
    };
  } else {
    body.user = JSON.parse(body.user);
    const { error, value } = userSchema.validate(body);

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

      const pfpResolution = await resolvePFP(body.wallet, file, value.user);
      console.log(
        '[VALIDATE USER]',
        `[RESOLVED PFP ${pfpResolution.success ? pfpResolution.pfp : `FALSE`}]`
      );

      if (!pfpResolution.success) {
        req.validatedBody = {
          valid: false,
          error: 'Invalid image'
        };
      } else if (!signatureValidation) {
        req.validatedBody = {
          valid: false,
          error: 'Invalid signature'
        };
      } else {
        const user: User = {
          created_at: new Date(),
          wallet: value.wallet,
          pfp: pfpResolution.pfp,
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
    meme: string;
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

async function resolvePFP(
  wallet: string,
  file: any,
  user: {
    pfp: string;
    meme: string;
    banner_1: string;
    banner_2: string;
    website: string;
  }
) {
  if (user.pfp && user.meme) {
    return {
      success: false
    };
  }

  if (user.pfp && file) {
    const fileExtension = path.extname(file.originalname);
    if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
      return {
        success: false
      };
    }
    const pfpResolution = await persistS3(wallet, file, fileExtension);
    return {
      success: true,
      pfp: pfpResolution
    };
  }

  if (user.meme) {
    console.log('[VALIDATE USER]', `[RESOLVING MEME ${user.meme}]`);
    const allMemes = await fetchMemesLite('asc');
    const foundMeme = allMemes.data.find((m: any) => m.id === user.meme);
    if (foundMeme) {
      return {
        success: true,
        pfp: foundMeme.thumbnail
      };
    } else {
      return {
        success: false
      };
    }
  }

  return {
    success: true,
    pfp: null
  };
}
