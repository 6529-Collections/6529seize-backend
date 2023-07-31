import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { areEqualAddresses } from '../../helpers';
import { ALCHEMY_SETTINGS } from '../../constants';
import { Alchemy, Nft, NftContract } from 'alchemy-sdk';
import { rememeExists } from '../../db-api';

const rememeSchema = Joi.object({
  contract: Joi.string().required(),
  token_ids: Joi.array().items(Joi.string()).required(),
  references: Joi.array().items(Joi.number()).required()
});

const rememeAddSchema = Joi.object({
  address: Joi.string().required(),
  signature: Joi.string().required(), // Add a comma after this line
  rememe: rememeSchema
});

export async function validateRememe(req: any, res: any, next: any) {
  const validation = await validateRememeBody(req.body);
  req.validatedBody = validation;
  next();
}

export async function validateRememeAdd(req: any, res: any, next: any) {
  const validation = await validateRememeBody(req.body);
  req.validatedBody = validation;
  next();
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
    } catch (e) {
      return {
        valid: false,
        error: e.message
      };
    }

    const myNfts: Nft[] = [];

    await Promise.all(
      value.token_ids.map(async (token_id: string) => {
        const nftMeta: any = await alchemy.nft.getNftMetadata(
          value.contract,
          token_id,
          {
            refreshCache: true
          }
        );
        const exists = await rememeExists(value.contract, token_id);
        if (exists) {
          nftMeta.metadataError = 'Rememe already exists';
        }
        myNfts.push(nftMeta);
      })
    );

    myNfts.map((n) => delete n.contract);

    return {
      valid: myNfts.find((n) => n.metadataError) === undefined,
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
  const verifySigner = ethers.utils.recoverAddress(
    hashMessage(JSON.stringify(rememe)),
    signature
  );

  return areEqualAddresses(address, verifySigner);
}
