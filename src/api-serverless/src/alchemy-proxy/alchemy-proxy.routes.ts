import { Network } from '@/ethereum-rpc/ethereum-rpc-network';
import { CustomApiCompliantException } from '@/exceptions';
import { ethers } from 'ethers';
import { NextFunction, Request, Response } from 'express';
import { getAlchemyInstance } from '../../../alchemy';
import { Time } from '../../../time';
import { cacheRequest } from '../request-cache';
import { handleContractMetadataBatch } from '@/api/alchemy-proxy/contract-metadata-batch.handler';
import { asyncRouter } from '@/api/async.router';
import {
  contractQuerySchema,
  MAX_TOKENS_PER_REQUEST,
  ownerNftsQuerySchema,
  TokenMetadataRequest,
  tokenMetadataCacheKey,
  tokenMetadataRequestSchema
} from '@/api/alchemy-proxy/alchemy-proxy.validation';

const router = asyncRouter();
const VALIDATED_TOKEN_METADATA = 'validatedTokenMetadataRequest';

// Legacy proxy routes live outside /api; the generated router mounts inside it.
router.post('/contracts', (req, res, next) => {
  void handleContractMetadataBatch(req, res).catch(next);
});

function isValidEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function resolveNetwork(chain: string = 'ethereum'): Network {
  const networkMap: Record<string, Network> = {
    ethereum: Network.ETH_MAINNET
  };
  return networkMap[chain] ?? Network.ETH_MAINNET;
}

function resolveNetworkByChainId(chainId: number): Network {
  if (chainId === 11155111) return Network.ETH_SEPOLIA;
  if (chainId === 5) return Network.ETH_GOERLI;
  return Network.ETH_MAINNET;
}

function checksumAddress(address: string): string | null {
  if (!isValidEthAddress(address)) return null;
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}

// Keep a terminal response for older clients without contacting the retired API.
router.get('/collections', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  throw new CustomApiCompliantException(
    410,
    'Collection name search is no longer available. Use a contract address.'
  );
});

router.get(
  '/contract',
  cacheRequest({ ttl: Time.minutes(5) }),
  async (req: Request, res: Response) => {
    const { error: invalid, value: query } = contractQuerySchema.validate(
      req.query
    );
    if (invalid) {
      return res.status(400).json({ error: 'address is required' });
    }
    const address = query.address;

    const checksum = checksumAddress(address);
    if (!checksum) {
      return res.json(null);
    }

    try {
      const network = resolveNetwork(query.chain);
      const alchemy = getAlchemyInstance(network);

      const result = await alchemy.nft.getContractMetadata(checksum);
      return res.json({ ...result, _checksum: checksum });
    } catch (error: any) {
      if (error?.status === 404) {
        return res.json(null);
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch contract metadata';
      return res.status(400).json({ error: message });
    }
  }
);

router.get(
  '/owner-nfts',
  cacheRequest({ ttl: Time.minutes(1) }),
  async (req: Request, res: Response) => {
    const chainId = Number(req.query.chainId);
    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: 'chainId is required' });
    }
    if (!req.query.contract || !req.query.owner) {
      return res.status(400).json({ error: 'contract and owner are required' });
    }
    const { error: invalid, value: query } = ownerNftsQuerySchema.validate(
      req.query
    );
    if (invalid) {
      return res.status(400).json({ error: invalid.message });
    }
    const { contract, owner, pageKey } = query;

    try {
      const network = resolveNetworkByChainId(chainId);
      const alchemy = getAlchemyInstance(network);

      const result = await alchemy.nft.getNftsForOwner(owner, {
        contractAddresses: [contract],
        pageKey
      });
      return res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch NFTs for owner';
      return res.status(400).json({ error: message });
    }
  }
);

function validateTokenMetadataRequest(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const body = req.body ?? {};
  const oversized = [body.tokens, body.tokenIds].some(
    (list) => Array.isArray(list) && list.length > MAX_TOKENS_PER_REQUEST
  );
  if (oversized) {
    throw new CustomApiCompliantException(
      413,
      `Maximum ${MAX_TOKENS_PER_REQUEST} tokens per request`
    );
  }
  const { error, value } = tokenMetadataRequestSchema.validate(body);
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.locals[VALIDATED_TOKEN_METADATA] = value;
  next();
}

function validatedTokenMetadataRequest(res: Response): TokenMetadataRequest {
  return res.locals[VALIDATED_TOKEN_METADATA] as TokenMetadataRequest;
}

router.post(
  '/token-metadata',
  validateTokenMetadataRequest,
  cacheRequest({
    ttl: Time.minutes(5),
    methods: ['POST'],
    key: (req) =>
      tokenMetadataCacheKey(req.res?.locals[VALIDATED_TOKEN_METADATA])
  }),
  async (req: Request, res: Response) => {
    const { address, tokenIds, tokens, chain } =
      validatedTokenMetadataRequest(res);

    let tokensToFetch: { contractAddress: string; tokenId: string }[] = [];

    if (tokens && tokens.length > 0) {
      tokensToFetch = tokens.map((t) => ({
        contractAddress: t.contract,
        tokenId: t.tokenId
      }));
    } else if (address && tokenIds && tokenIds.length > 0) {
      const checksum = checksumAddress(address);
      if (!checksum) {
        return res.json({ tokens: [] });
      }
      tokensToFetch = tokenIds.map((tokenId) => ({
        contractAddress: checksum,
        tokenId
      }));
    }

    if (tokensToFetch.length === 0) {
      return res.status(400).json({
        error: 'Either tokens OR (address and tokenIds) are required'
      });
    }

    try {
      const network = resolveNetwork(chain);
      const alchemy = getAlchemyInstance(network);
      const batchResult = await alchemy.nft.getNftMetadataBatch(tokensToFetch);
      return res.json({ tokens: batchResult.nfts });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to fetch token metadata';
      return res.status(400).json({ error: message });
    }
  }
);

export default router;
