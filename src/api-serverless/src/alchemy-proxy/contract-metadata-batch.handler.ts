import type { Request, Response } from 'express';
import * as Joi from 'joi';
import { ethers } from 'ethers';
import { Alchemy } from '@/alchemy-sdk';
import { getAlchemyInstance } from '@/alchemy';
import { Logger } from '@/logging';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import type { ApiAlchemyContractMetadataBatchRequest } from '@/api/generated/models/ApiAlchemyContractMetadataBatchRequest';
import type { ApiAlchemyContractMetadataBatchResponse } from '@/api/generated/models/ApiAlchemyContractMetadataBatchResponse';
import {
  type ApiAlchemyContractMetadataRequest,
  ApiAlchemyContractMetadataRequestChainEnum
} from '@/api/generated/models/ApiAlchemyContractMetadataRequest';
import {
  type ApiAlchemyContractMetadataResult,
  ApiAlchemyContractMetadataResultChainEnum
} from '@/api/generated/models/ApiAlchemyContractMetadataResult';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { CustomApiCompliantException } from '@/exceptions';

const MAX_CONTRACTS = 50;
const LOOKUP_CONCURRENCY = 10;
const LOOKUP_TIMEOUT_MS = 5000;
const boundedClients = new WeakMap<Alchemy, Alchemy>();
const logger = Logger.get('ALCHEMY_METADATA_BATCH');
const requestSchema = Joi.object<ApiAlchemyContractMetadataBatchRequest>({
  contracts: Joi.array()
    .items(
      Joi.object({
        address: Joi.string()
          .pattern(/^0x[0-9a-fA-F]{40}$/)
          .required(),
        chain: Joi.string().valid('ethereum').default('ethereum')
      })
    )
    .required()
}).required();

function getBatchAlchemyClient(): Alchemy {
  try {
    const sharedClient = getAlchemyInstance(Network.ETH_MAINNET);
    const cached = boundedClients.get(sharedClient);
    if (cached) return cached;
    // Reuse the central configuration, with a cached client whose finite budget
    // keeps a 50-contract batch within the API request deadline.
    const client = new Alchemy({
      ...sharedClient.config,
      maxRetries: 0,
      timeoutMs: LOOKUP_TIMEOUT_MS
    });
    boundedClients.set(sharedClient, client);
    return client;
  } catch {
    logger.error('Unable to initialize the contract metadata provider');
    throw new CustomApiCompliantException(
      500,
      'Contract metadata provider is unavailable'
    );
  }
}

function normalizeContracts(
  contracts: ApiAlchemyContractMetadataRequest[]
): ApiAlchemyContractMetadataRequest[] {
  const unique = new Map<string, ApiAlchemyContractMetadataRequest>();
  for (const contract of contracts) {
    // Joi guarantees 40 hex digits. Lowercase first so differently cased
    // aliases share one lookup without mixed-case checksum ambiguity.
    const address = ethers.getAddress(contract.address.toLowerCase());
    unique.set(address, {
      address,
      chain: ApiAlchemyContractMetadataRequestChainEnum.Ethereum
    });
  }
  return Array.from(unique.values());
}

function upstreamStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = error.status;
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return status;
    }
  }
  return 502;
}

async function lookupContract(
  alchemy: Alchemy,
  contract: ApiAlchemyContractMetadataRequest
): Promise<ApiAlchemyContractMetadataResult> {
  const base = {
    address: contract.address,
    chain: ApiAlchemyContractMetadataResultChainEnum.Ethereum
  };
  try {
    const metadata: unknown = await alchemy.nft.getContractMetadata(
      contract.address
    );
    if (
      typeof metadata !== 'object' ||
      metadata === null ||
      Array.isArray(metadata)
    ) {
      throw new Error('Invalid contract metadata response');
    }
    return { ...base, metadata: { ...metadata, _checksum: contract.address } };
  } catch (error: unknown) {
    const status = upstreamStatus(error);
    if (status === 404) {
      return { ...base, metadata: null };
    }
    // Avoid returning provider errors containing credentials or request URLs.
    return {
      ...base,
      metadata: null,
      error: 'Failed to fetch contract metadata',
      status
    };
  }
}

export async function handleContractMetadataBatch(
  req: Request,
  res: Response
): Promise<Response> {
  res.setHeader('Cache-Control', 'no-store');
  // An oversized array takes precedence over item validation and returns 413.
  if (
    Array.isArray(req.body?.contracts) &&
    req.body.contracts.length > MAX_CONTRACTS
  ) {
    throw new CustomApiCompliantException(
      413,
      `Maximum ${MAX_CONTRACTS} contracts per request`
    );
  }
  const body = getValidatedByJoiOrThrow(req.body, requestSchema);
  const contracts = normalizeContracts(body.contracts);
  const result: ApiAlchemyContractMetadataBatchResponse = { contracts: [] };
  if (contracts.length === 0) {
    return res.json(result);
  }
  const alchemy = getBatchAlchemyClient();
  for (
    let offset = 0;
    offset < contracts.length;
    offset += LOOKUP_CONCURRENCY
  ) {
    const entries = await Promise.all(
      contracts
        .slice(offset, offset + LOOKUP_CONCURRENCY)
        .map((contract) => lookupContract(alchemy, contract))
    );
    result.contracts.push(...entries);
  }
  return res.json(result);
}
