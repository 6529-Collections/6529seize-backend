import { Network } from 'alchemy-sdk';
import { ethers } from 'ethers';
import { Request, Response, Router } from 'express';
import { getAlchemyInstance } from '../../../alchemy';
import { Time } from '../../../time';
import { cacheRequest } from '../request-cache';

const router = Router();

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

router.get(
  '/collections',
  cacheRequest({ ttl: Time.minutes(1) }),
  async (req: Request, res: Response) => {
    const query = (req.query.query as string)?.trim();
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    try {
      const chain = (req.query.chain as string) ?? 'ethereum';
      const network = resolveNetwork(chain);
      const alchemy = getAlchemyInstance(network);

      const result = await alchemy.nft.searchContractMetadata(query);
      return res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to search NFT collections';
      return res.status(400).json({ error: message });
    }
  }
);

router.get(
  '/contract',
  cacheRequest({ ttl: Time.minutes(5) }),
  async (req: Request, res: Response) => {
    const address = req.query.address as string;
    if (!address || !isValidEthAddress(address)) {
      return res.status(400).json({ error: 'address is required' });
    }

    const checksum = checksumAddress(address);
    if (!checksum) {
      return res.json(null);
    }

    try {
      const chain = (req.query.chain as string) ?? 'ethereum';
      const network = resolveNetwork(chain);
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
    const chainIdRaw = req.query.chainId as string;
    const contract = req.query.contract as string;
    const owner = req.query.owner as string;
    const pageKey = req.query.pageKey as string | undefined;

    const chainId = Number(chainIdRaw);
    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: 'chainId is required' });
    }
    if (!contract || !owner) {
      return res.status(400).json({ error: 'contract and owner are required' });
    }

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

router.post(
  '/token-metadata',
  cacheRequest({
    ttl: Time.minutes(5),
    methods: ['POST'],
    key: (req) => {
      const { address, tokenIds, tokens, chain } = req.body ?? {};
      return `alchemy-token-metadata:${chain ?? 'ethereum'}:${JSON.stringify(tokens ?? [])}:${address ?? ''}:${JSON.stringify(tokenIds ?? [])}`;
    }
  }),
  async (req: Request, res: Response) => {
    const { address, tokenIds, tokens, chain = 'ethereum' } = req.body ?? {};

    let tokensToFetch: { contractAddress: string; tokenId: string }[] = [];

    if (tokens && tokens.length > 0) {
      tokensToFetch = tokens.map(
        (t: { contract: string; tokenId: string }) => ({
          contractAddress: t.contract,
          tokenId: t.tokenId
        })
      );
    } else if (address && Array.isArray(tokenIds) && tokenIds.length > 0) {
      if (!isValidEthAddress(address)) {
        return res.status(400).json({ error: 'Invalid contract address' });
      }
      const checksum = checksumAddress(address);
      if (!checksum) {
        return res.json({ tokens: [] });
      }
      tokensToFetch = tokenIds.map((tokenId: string) => ({
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
      const allTokens: unknown[] = [];
      const MAX_BATCH_SIZE = 100;

      for (let i = 0; i < tokensToFetch.length; i += MAX_BATCH_SIZE) {
        const slice = tokensToFetch.slice(i, i + MAX_BATCH_SIZE);
        const batchResult = await alchemy.nft.getNftMetadataBatch(slice);
        allTokens.push(...batchResult.nfts);
      }

      return res.json({ tokens: allTokens });
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
