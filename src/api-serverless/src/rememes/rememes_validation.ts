import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { ALCHEMY_SETTINGS } from '@/constants';
import { Alchemy, Nft, NftContract } from 'alchemy-sdk';
import { getTdhForAddress, rememeExists } from '../../../db-api';
import { seizeSettings } from '@/api/seize-settings';
import { equalIgnoreCase } from '../../../strings';

const rememeSchema = Joi.object({
  contract: Joi.string().required(),
  token_ids: Joi.array().items(Joi.string()).required(),
  references: Joi.array().items(Joi.number()).required()
});

const rememeAddSchema = Joi.object({
  address: Joi.string().required(),
  signature: Joi.string().required(),
  rememe: rememeSchema
});

export async function validateRememe(req: any, res: any, next: any) {
  const validation = await validateRememeBody(req.body);
  req.validatedBody = validation;
  next();
}

export async function validateRememeAdd(req: any, res: any, next: any) {
  const rememeValidation = await validateRememeBody(req.body.rememe);

  if (!rememeValidation.valid) {
    req.validatedBody = rememeValidation;
    next();
  } else {
    const { error, value } = rememeAddSchema.validate(req.body);
    if (error) {
      req.validatedBody = {
        valid: false,
        error: error.message
      };
      next();
    } else {
      const signatureValidation = validateSignature(
        value.address,
        value.signature,
        value.rememe
      );
      const tdhValidation = await validateTDH(
        value.address,
        rememeValidation.contract?.address,
        rememeValidation.contract?.contractDeployer
      );
      if (!signatureValidation) {
        req.validatedBody = {
          valid: false,
          error: 'Invalid signature'
        };
        next();
      } else if (!tdhValidation) {
        req.validatedBody = {
          valid: false,
          error: 'Insufficient TDH'
        };
        next();
      } else {
        req.validatedBody = {
          ...rememeValidation,
          address: value.address,
          references: value.rememe.references
        };
        next();
      }
    }
  }
}

async function validateRememeBody(body: any) {
  if (!body) {
    return {
      valid: false,
      error: 'Empty request body'
    };
  }

  const { error, value } = rememeSchema.validate(body);

  if (error) {
    return {
      valid: false,
      error: error.message
    };
  } else if (value.token_ids.length === 0) {
    const error = 'token_ids must be an array of strings';
    return {
      valid: false,
      error: error
    };
  } else {
    const alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });

    let myContract: NftContract;
    try {
      myContract = await alchemy.nft.getContractMetadata(value.contract);
    } catch (e: any) {
      return {
        valid: false,
        error: 'Invalid Contract'
      };
    }

    const myNfts: Nft[] = await Promise.all(
      value.token_ids.map(async (token_id: string) => {
        try {
          const nftMeta: any = await alchemy.nft.getNftMetadata(
            value.contract,
            token_id,
            {
              refreshCache: true
            }
          );
          const exists = await rememeExists(value.contract, token_id);
          if (exists) {
            nftMeta.raw.error = 'Rememe already exists';
          }
          delete nftMeta.contract;
          return nftMeta;
        } catch (e: any) {
          return {
            metadataError: `Error fetching metadata for token_id ${token_id}: ${e.message}`
          };
        }
      })
    );

    return {
      valid: myNfts.find((n) => n.raw.error) === undefined,
      contract: myContract,
      nfts: myNfts
    };
  }
}

function validateSignature(
  address: string,
  signature: string,
  rememe: { contract: string; id: number; meme_references: number[] }
) {
  try {
    const verifySigner = ethers.recoverAddress(
      hashMessage(JSON.stringify(rememe)),
      signature
    );
    return equalIgnoreCase(address, verifySigner);
  } catch (e) {
    return false;
  }
}

async function validateTDH(
  address?: string,
  contractAddress?: string,
  deployer?: string
) {
  if (!address || !contractAddress || !deployer) {
    return false;
  }

  if (equalIgnoreCase(address, deployer)) {
    return true;
  }

  const tdh = await getTdhForAddress(address);
  return tdh >= seizeSettings().rememes_submission_tdh_threshold;
}
