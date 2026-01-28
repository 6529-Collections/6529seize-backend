import { ethers } from 'ethers';
import * as Joi from 'joi';
import { hashMessage } from '@ethersproject/hash';
import { Readable } from 'stream';
import {
  getNextGenChainId,
  NEXTGEN_ADMIN,
  NEXTGEN_ADMIN_ABI,
  NEXTGEN_SET_COLLECTION_PHASES_SELECTOR
} from './abis';
import { Logger } from '../../../logging';
import { numbers } from '../../../numbers';
import { equalIgnoreCase } from '../../../strings';
import { getRpcUrl } from '../../../alchemy';

const { keccak256 } = require('@ethersproject/keccak256');
const { MerkleTree } = require('merkletreejs');

const csv = require('csv-parser');
const path = require('path');

const logger = Logger.get('NEXTGEN_VALIDATION');

export enum NextGenAllowlistType {
  ALLOWLIST = 'allowlist',
  EXTERNAL_BURN = 'external_burn'
}

const nextgenSchema = Joi.object({
  wallet: Joi.string().required(),
  signature: Joi.string().required(),
  collection_id: Joi.number().required(),
  uuid: Joi.string().required(),
  phase: Joi.string().required(),
  start_time: Joi.number().required(),
  end_time: Joi.number().required(),
  mint_price: Joi.number().required(),
  al_type: Joi.string()
    .valid(...Object.values(NextGenAllowlistType))
    .required()
});

const nextgenCollectionBurnSchema = Joi.object({
  wallet: Joi.string().required(),
  signature: Joi.string().required(),
  uuid: Joi.string().required(),
  collection_id: Joi.number().required(),
  burn_collection: Joi.string().required(),
  burn_collection_id: Joi.number().required(),
  min_token_index: Joi.number().required(),
  max_token_index: Joi.number().required(),
  burn_address: Joi.string().required(),
  status: Joi.boolean().required()
});

interface UploadAllowlist {
  address: string;
  spots: number;
  info: string;
}

interface UploadAllowlistBurn {
  token_id: string;
  info: string;
}

export async function validateNextgen(req: any, res: any, next: any) {
  logger.info('[VALIDATING NEXTGEN...]');

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

    let allowlist: UploadAllowlist[] | UploadAllowlistBurn[] = [];
    let merkle: any = null;
    if (value.al_type === NextGenAllowlistType.ALLOWLIST) {
      allowlist = await readAllowlist(allowlistFile.buffer);
      merkle = await computeMerkle(allowlist);
    }
    if (value.al_type === NextGenAllowlistType.EXTERNAL_BURN) {
      allowlist = await readAllowlistBurn(allowlistFile.buffer);
      merkle = await computeMerkleBurn(allowlist);
    }

    if (allowlist.length == 0 || !merkle) {
      return handleValidationFailure(
        req,
        false,
        'Something went wrong while computing merkle tree',
        next
      );
    }

    logger.info(`[ALLOWLIST ${allowlist.length} ENTRIES]`);

    req.validatedBody = {
      valid: true,
      collection_id: value.collection_id,
      added_by: value.wallet,
      al_type: value.al_type,
      merkle: merkle,
      phase: value.phase,
      start_time: value.start_time,
      end_time: value.end_time,
      mint_price: value.mint_price
    };

    return next();
  } catch (err: any) {
    return handleValidationFailure(req, false, err.message, next);
  }
}

export async function validateNextgenBurn(req: any, res: any, next: any) {
  logger.info('[VALIDATING NEXTGEN COLLECTION BURN...]');

  const collectionBurn = req.body;

  if (!collectionBurn) {
    return handleValidationFailure(req, false, 'Body missing', next);
  }

  try {
    const { error, value } =
      nextgenCollectionBurnSchema.validate(collectionBurn);

    if (error) {
      return handleValidationFailure(req, false, error.message, next);
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

    req.validatedBody = {
      valid: true,
      collection_id: value.collection_id,
      burn_collection: value.burn_collection,
      burn_collection_id: value.burn_collection_id,
      min_token_index: value.min_token_index,
      max_token_index: value.max_token_index,
      burn_address: value.burn_address,
      status: value.status
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
    const verifySigner = ethers.recoverAddress(hashMessage(uuid), signature);
    return equalIgnoreCase(address, verifySigner);
  } catch (e) {
    logger.error('error', e);
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
      spots: numbers.parseIntOrNull(data[1]) ?? 0,
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

async function readAllowlistBurn(
  allowlistFileBuffer: Buffer
): Promise<UploadAllowlistBurn[]> {
  const allowlist: UploadAllowlistBurn[] = [];

  const bufferStream = new Readable();
  bufferStream.push(allowlistFileBuffer);
  bufferStream.push(null);

  bufferStream.pipe(csv({ headers: false })).on('data', (data: any) => {
    allowlist.push({
      token_id: data[0],
      info: data[1]
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
    const parsedSpots = spots.toString(16).padStart(64, '0');
    const info = al.info;
    const parsedInfo = stringToHex(info);
    const concatenatedData = `${parsedAddress}${parsedSpots}${parsedInfo}`;
    const bufferData = Buffer.from(concatenatedData, 'hex');
    const result = keccak256(keccak256(bufferData)).slice(2);

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

async function computeMerkleBurn(
  allowlist: UploadAllowlistBurn[]
): Promise<any> {
  const processedAllowlist = allowlist.map((al) => {
    const tokenId = numbers.parseIntOrNull(al.token_id) ?? 0;
    const info = al.info;
    const parsedTokenId = tokenId.toString(16).padStart(64, '0');
    const parsedInfo = stringToHex(info);
    const concatenatedData = `${parsedTokenId}${parsedInfo}`;
    const bufferData = Buffer.from(concatenatedData, 'hex');
    const result = keccak256(keccak256(bufferData)).slice(2);

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
  const chainId = getNextGenChainId();
  const rpcUrl = getRpcUrl(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const contract = new ethers.Contract(
    NEXTGEN_ADMIN[chainId],
    NEXTGEN_ADMIN_ABI,
    provider
  );

  try {
    const isGlobalAdmin = await contract.retrieveGlobalAdmin(address);

    const isFunctionAdmin = await contract.retrieveFunctionAdmin(
      address,
      NEXTGEN_SET_COLLECTION_PHASES_SELECTOR
    );

    const isCollectionAdmin = await contract.retrieveCollectionAdmin(
      address,
      collection_id
    );
    logger.info({
      global_admin: isGlobalAdmin,
      function_admin: isFunctionAdmin,
      collection_admin: isCollectionAdmin
    });
    return isGlobalAdmin || isFunctionAdmin || isCollectionAdmin;
  } catch (error) {
    logger.error(
      `Error calling retrieveGlobalAdmin method. rpcUrl: '${rpcUrl}' error: ${JSON.stringify(
        error
      )}`
    );
    return false;
  }
}

function stringToHex(s: string) {
  let hexString = '';
  for (let i = 0; i < s.length; i++) {
    const hex = s.charCodeAt(i).toString(16);
    hexString += hex;
  }
  return hexString;
}
