import { createHash } from 'node:crypto';
import * as Joi from 'joi';

/** Same bound as the web app's own token metadata route. */
export const MAX_TOKENS_PER_REQUEST = 100;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ENS_NAME_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
// Decimal (up to uint256) or hex token ids, as accepted by the provider.
const TOKEN_ID_PATTERN = /^(\d{1,78}|0x[0-9a-fA-F]{1,64})$/;

const addressSchema = Joi.string().pattern(ADDRESS_PATTERN);
const chainSchema = Joi.string().max(32).default('ethereum');
const tokenIdSchema = Joi.alternatives()
  .try(
    Joi.string().pattern(TOKEN_ID_PATTERN),
    Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER)
  )
  .custom((value: string | number) => String(value));

export interface ContractQuery {
  address: string;
  chain: string;
}

export const contractQuerySchema = Joi.object<ContractQuery>({
  address: addressSchema.required(),
  chain: chainSchema
}).unknown(true);

export interface OwnerNftsQuery {
  chainId: number;
  contract: string;
  owner: string;
  pageKey?: string;
}

export const ownerNftsQuerySchema = Joi.object<OwnerNftsQuery>({
  chainId: Joi.number().integer().min(1).required(),
  contract: addressSchema.required(),
  owner: Joi.alternatives()
    .try(addressSchema, Joi.string().max(255).pattern(ENS_NAME_PATTERN))
    .required(),
  pageKey: Joi.string().max(1024).optional()
}).unknown(true);

export interface TokenMetadataRequest {
  address?: string;
  tokenIds?: string[];
  tokens?: { contract: string; tokenId: string }[];
  chain: string;
}

export const tokenMetadataRequestSchema = Joi.object<TokenMetadataRequest>({
  address: addressSchema.optional(),
  tokenIds: Joi.array()
    .items(tokenIdSchema.required())
    .max(MAX_TOKENS_PER_REQUEST)
    .optional(),
  tokens: Joi.array()
    .items(
      Joi.object({
        contract: addressSchema.required(),
        tokenId: tokenIdSchema.required()
      })
    )
    .max(MAX_TOKENS_PER_REQUEST)
    .optional(),
  chain: chainSchema
})
  .unknown(true)
  .required();

/**
 * A fixed-length cache key for a validated token metadata request. Only the
 * fields the handler reads contribute, so unrelated body fields do not
 * produce distinct entries.
 */
export function tokenMetadataCacheKey(
  request: TokenMetadataRequest | undefined
): string | null {
  if (!request) {
    return null;
  }
  const canonical = JSON.stringify([
    request.chain,
    (request.tokens ?? []).map((token) => [token.contract, token.tokenId]),
    request.address ?? '',
    request.tokenIds ?? []
  ]);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `alchemy-token-metadata:${digest}`;
}
