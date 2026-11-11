import { ethers, hashMessage } from 'ethers';
import * as Joi from 'joi';
import { ALCHEMY_SETTINGS } from '@/constants';
import { Alchemy, Nft, NftContract } from '@/alchemy-sdk';
import { getTdhForAddress, rememeExists } from '@/db-api';
import { seizeSettings } from '@/api/seize-settings';
import { equalIgnoreCase } from '@/strings';
import {
  ETHEREUM_MAINNET_CHAIN_ID,
  hashStructuredWalletSignaturePayload,
  isStructuredSignaturesRequired,
  verifyStructuredWalletSignature
} from '@/api/wallet-signatures/structured-wallet-signatures';

/** Each token id costs provider lookups, so one request is bounded. */
export const MAX_REMEME_TOKEN_IDS = 100;
const MAX_REMEME_REFERENCES = 1000;

const rememeSchema = Joi.object({
  contract: Joi.string().max(100).required(),
  token_ids: Joi.array()
    .items(Joi.string().max(100))
    .max(MAX_REMEME_TOKEN_IDS)
    .required(),
  references: Joi.array()
    .items(Joi.number())
    .max(MAX_REMEME_REFERENCES)
    .required()
});

const rememeAddSchema = Joi.object({
  address: Joi.string().max(100).required(),
  signature: Joi.string().max(10_000).required(),
  signature_message: Joi.string().max(10_000).optional().allow(null),
  rememe: rememeSchema.required()
});

export async function validateRememe(req: any, res: any, next: any) {
  const validation = await validateRememeBody(req.body);
  req.validatedBody = validation;
  next();
}

/**
 * Checks the request shape and the wallet signature before any provider
 * lookup, so only signed submissions reach the metadata provider.
 */
export async function validateRememeAdd(req: any, res: any, next: any) {
  req.validatedBody = await validateRememeAddBody(req.body);
  next();
}

async function validateRememeAddBody(body: any): Promise<any> {
  if (!body?.rememe) {
    return { valid: false, error: 'Empty request body' };
  }
  const { error, value } = rememeAddSchema.validate(body);
  if (error) {
    return { valid: false, error: error.message };
  }
  if (value.rememe.token_ids.length === 0) {
    return { valid: false, error: 'token_ids must be an array of strings' };
  }
  const signatureValidation = await validateSignature(
    value.address,
    value.signature,
    value.rememe,
    value.signature_message ?? null
  );
  if (!signatureValidation) {
    return { valid: false, error: 'Invalid signature' };
  }
  const rememeValidation = await validateRememeBody(body.rememe);
  if (!rememeValidation.valid) {
    return rememeValidation;
  }
  const contract = rememeValidation.contract as NftContract | undefined;
  const tdhValidation = await validateTDH(
    value.address,
    contract?.contractDeployer
  );
  if (!tdhValidation) {
    return { valid: false, error: 'Insufficient TDH' };
  }
  return {
    ...rememeValidation,
    address: value.address,
    references: value.rememe.references
  };
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
            nftMeta.raw = nftMeta.raw ?? {};
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
      valid: !myNfts.some((n: any) => n.raw?.error || n.metadataError),
      contract: {
        ...myContract,
        address: myContract.address ?? value.contract
      },
      nfts: myNfts
    };
  }
}

async function validateSignature(
  address: string,
  signature: string,
  rememe: unknown,
  signatureMessage: string | null
): Promise<boolean> {
  if (signatureMessage) {
    const signingAddress = await verifyStructuredWalletSignature({
      message: signatureMessage,
      signature,
      expectedAddress: address,
      expectedChainId: ETHEREUM_MAINNET_CHAIN_ID,
      expectedAction: 'add_rememe',
      expectedKind: 'action',
      expectedPayloadHash: hashStructuredWalletSignaturePayload(rememe)
    });
    return signingAddress !== null;
  }

  if (isStructuredSignaturesRequired()) {
    return false;
  }

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

export async function validateTDH(address?: string, deployer?: string) {
  if (!address) {
    return false;
  }

  if (deployer && equalIgnoreCase(address, deployer)) {
    return true;
  }

  const tdh = await getTdhForAddress(address);
  return tdh >= seizeSettings().rememes_submission_tdh_threshold;
}
