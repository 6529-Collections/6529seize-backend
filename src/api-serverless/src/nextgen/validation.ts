import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { areEqualAddresses, stringToHex } from '../../../helpers';
import { Readable } from 'stream';
import { NEXTGEN_ADMIN } from '../../../constants';
import {
  NEXTGEN_ADMIN_ABI,
  NEXTGEN_CHAIN_ID,
  NEXTGEN_FUNCTION_SELECTOR
} from './abis';
const { keccak256 } = require('@ethersproject/keccak256');
const { MerkleTree } = require('merkletreejs');

const csv = require('csv-parser');
const path = require('path');

const nextgenSchema = Joi.object({
  wallet: Joi.string().required(),
  signature: Joi.string().required(),
  collection_id: Joi.number().required(),
  uuid: Joi.string().required()
});

interface UploadAllowlist {
  address: string;
  spots: number;
  info: string;
}

export async function validateNextgen(req: any, res: any, next: any) {
  console.log('[VALIDATE NEXTGEN]', `[VALIDATING...]`);

  const nextgen = req.body?.nextgen;
  const allowlistFile = req.file;

  if (!nextgen || !allowlistFile) {
    return handleValidationFailure(req, false, 'Body or File missing', next);
  }

  try {
    const parsedNextgen = JSON.parse(nextgen);
    const fileExtension = path.extname(allowlistFile.originalname);

    const { error, value } = nextgenSchema.validate(parsedNextgen);

    if (error) {
      return handleValidationFailure(req, false, error.message, next);
    }

    if (fileExtension !== '.csv') {
      return handleValidationFailure(req, false, 'Invalid file', next);
    }

    const signatureValidation = validateSignature(
      value.wallet,
      value.signature,
      value.uuid
    );

    if (!signatureValidation) {
      return handleValidationFailure(req, false, 'Invalid signature', next);
    }

    const adminValidation = await validateAdmin(
      value.collection_id,
      value.wallet
    );

    if (!adminValidation) {
      return handleValidationFailure(req, false, 'Invalid admin', next);
    }

    const allowlist = await readAllowlist(allowlistFile.buffer);
    const merkle = await computeMerkle(allowlist);

    console.log(
      '[VALIDATE NEXTGEN]',
      `[ALLOWLIST ${allowlist.length} ENTRIES]`
    );

    req.validatedBody = {
      valid: true,
      collection_id: value.collection_id,
      added_by: value.wallet,
      merkle: merkle
    };

    return next();
  } catch (err: any) {
    return handleValidationFailure(req, false, err.message, next);
  }
}

function handleValidationFailure(
  req: any,
  valid: boolean,
  error: string,
  next: any
) {
  req.validatedBody = {
    valid: valid,
    error: error
  };
  return next();
}

function validateSignature(address: string, signature: string, uuid: string) {
  try {
    const verifySigner = ethers.utils.recoverAddress(
      hashMessage(uuid),
      signature
    );
    return areEqualAddresses(address, verifySigner);
  } catch (e) {
    console.log('error', e);
    return false;
  }
}

async function readAllowlist(
  allowlistFileBuffer: Buffer
): Promise<UploadAllowlist[]> {
  const allowlist: UploadAllowlist[] = [];

  const bufferStream = new Readable();
  bufferStream.push(allowlistFileBuffer);
  bufferStream.push(null);

  bufferStream.pipe(csv({ headers: false })).on('data', (data: any) => {
    allowlist.push({
      address: data[0],
      spots: parseInt(data[1]),
      info: data[2]
    });
  });

  await new Promise((resolve, reject) => {
    bufferStream.on('end', () => {
      resolve(true);
    });
    bufferStream.on('error', (err) => {
      reject(err);
    });
  });

  return allowlist;
}

async function computeMerkle(allowlist: UploadAllowlist[]): Promise<any> {
  const processedAllowlist = allowlist.map((al) => {
    const parsedAddress = al.address.startsWith('0x')
      ? al.address.slice(2)
      : al.address;
    const spots = al.spots;
    const parsedSpots = spots.toString().padStart(64, '0');
    const info = al.info;
    const parsedInfo = stringToHex(info);
    const concatenatedData = `${parsedAddress}${parsedSpots}${parsedInfo}`;
    const bufferData = Buffer.from(concatenatedData, 'hex');
    const result = keccak256(bufferData).slice(2);

    return {
      ...al,
      keccak: result
    };
  });

  const leaves = processedAllowlist.map((al) => al.keccak);
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });

  return {
    merkle_root: merkleTree.getHexRoot(),
    merkle_tree: merkleTree,
    allowlist: processedAllowlist
  };
}

async function validateAdmin(collection_id: number, address: string) {
  const rpcUrl = getUrl(NEXTGEN_CHAIN_ID);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(
    NEXTGEN_ADMIN,
    NEXTGEN_ADMIN_ABI,
    provider
  );

  try {
    const result1 = await contract.functions.retrieveGlobalAdmin(address);
    const isGlobalAdmin = result1[0];

    const result2 = await contract.functions.retrieveFunctionAdmin(
      address,
      NEXTGEN_FUNCTION_SELECTOR
    );
    const isFunctionAdmin = result2[0];

    const result3 = await contract.functions.retrieveCollectionAdmin(
      address,
      collection_id
    );
    const isCollectionAdmin = result3[0];
    console.log(
      '[VALIDATE NEXTGEN]',
      `[GLOBAL ADMIN ${isGlobalAdmin}]`,
      `[FUNCTION ADMIN ${isFunctionAdmin}]`,
      `[COLLECTION ADMIN ${isCollectionAdmin}]`
    );
    return isGlobalAdmin || isFunctionAdmin || isCollectionAdmin;
  } catch (error) {
    console.error('Error calling retrieveGlobalAdmin method:', rpcUrl, error);
    return false;
  }
}

function getUrl(chainId: number) {
  switch (chainId) {
    case 5:
      return `https://eth-goerli.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
    default:
      return `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }
}
