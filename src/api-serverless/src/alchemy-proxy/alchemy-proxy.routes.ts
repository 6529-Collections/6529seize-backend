import { ethers } from 'ethers';
import { Request, Response, Router } from 'express';
import fetch from 'node-fetch';

const router = Router();

function getAlchemyApiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error('ALCHEMY_API_KEY environment variable is required');
  }
  return key;
}

function isValidEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function resolveNetwork(chain: string = 'ethereum'): string {
  const networkMap: Record<string, string> = { ethereum: 'eth-mainnet' };
  return networkMap[chain] ?? 'eth-mainnet';
}

function resolveNetworkByChainId(chainId: number): string {
  if (chainId === 11155111) return 'eth-sepolia';
  if (chainId === 5) return 'eth-goerli';
  return 'eth-mainnet';
}

function checksumAddress(address: string): string | null {
  if (!isValidEthAddress(address)) return null;
  try {
    return ethers.utils.getAddress(address);
  } catch {
    return address;
  }
}

function setNoCacheHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

// GET /alchemy-proxy/collections
router.get('/collections', async (req: Request, res: Response) => {
  const query = (req.query.query as string)?.trim();
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const apiKey = getAlchemyApiKey();
    const chain = (req.query.chain as string) ?? 'ethereum';
    const pageKey = req.query.pageKey as string | undefined;
    const network = resolveNetwork(chain);

    const url = new URL(
      `https://${network}.g.alchemy.com/nft/v3/${apiKey}/searchContractMetadata`
    );
    url.searchParams.set('query', query);
    if (pageKey) url.searchParams.set('pageKey', pageKey);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: 'Failed to search NFT collections' });
    }

    const payload = await response.json();
    setNoCacheHeaders(res);
    return res.json(payload);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to search NFT collections';
    return res.status(400).json({ error: message });
  }
});

// GET /alchemy-proxy/contract
router.get('/contract', async (req: Request, res: Response) => {
  const address = req.query.address as string;
  if (!address || !isValidEthAddress(address)) {
    return res.status(400).json({ error: 'address is required' });
  }

  const checksum = checksumAddress(address);
  if (!checksum) {
    setNoCacheHeaders(res);
    return res.json(null);
  }

  try {
    const apiKey = getAlchemyApiKey();
    const chain = (req.query.chain as string) ?? 'ethereum';
    const network = resolveNetwork(chain);

    const url = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getContractMetadata?contractAddress=${checksum}`;

    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });

    if (response.status === 404) {
      setNoCacheHeaders(res);
      return res.json(null);
    }

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: 'Failed to fetch contract metadata' });
    }

    const payload = await response.json();
    setNoCacheHeaders(res);
    // Add checksum for frontend processing
    return res.json({ ...payload, _checksum: checksum });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to fetch contract metadata';
    return res.status(400).json({ error: message });
  }
});

// GET /alchemy-proxy/owner-nfts
router.get('/owner-nfts', async (req: Request, res: Response) => {
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
    const apiKey = getAlchemyApiKey();
    const network = resolveNetworkByChainId(chainId);

    let url = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner?owner=${owner}&contractAddresses[]=${contract}`;
    if (pageKey) url += `&pageKey=${pageKey}`;

    const response = await fetch(url, {
      headers: { accept: 'application/json' }
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: 'Failed to fetch NFTs for owner' });
    }

    const payload = await response.json();
    setNoCacheHeaders(res);
    return res.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch NFTs for owner';
    return res.status(400).json({ error: message });
  }
});

// POST /alchemy-proxy/token-metadata
router.post('/token-metadata', async (req: Request, res: Response) => {
  const { address, tokenIds, tokens, chain = 'ethereum' } = req.body ?? {};

  let tokensToFetch: { contractAddress: string; tokenId: string }[] = [];

  if (tokens && tokens.length > 0) {
    tokensToFetch = tokens.map((t: { contract: string; tokenId: string }) => ({
      contractAddress: t.contract,
      tokenId: t.tokenId
    }));
  } else if (address && Array.isArray(tokenIds) && tokenIds.length > 0) {
    if (!isValidEthAddress(address)) {
      return res.status(400).json({ error: 'Invalid contract address' });
    }
    const checksum = checksumAddress(address);
    if (!checksum) {
      setNoCacheHeaders(res);
      return res.json({ tokens: [] });
    }
    tokensToFetch = tokenIds.map((tokenId: string) => ({
      contractAddress: checksum,
      tokenId
    }));
  }

  if (tokensToFetch.length === 0) {
    return res
      .status(400)
      .json({ error: 'Either tokens OR (address and tokenIds) are required' });
  }

  try {
    const apiKey = getAlchemyApiKey();
    const network = resolveNetwork(chain);
    const url = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadataBatch`;
    const allTokens: unknown[] = [];
    const MAX_BATCH_SIZE = 100;

    for (let i = 0; i < tokensToFetch.length; i += MAX_BATCH_SIZE) {
      const slice = tokensToFetch.slice(i, i + MAX_BATCH_SIZE);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ tokens: slice })
      });

      if (!response.ok) {
        return res
          .status(response.status)
          .json({ error: 'Failed to fetch token metadata' });
      }

      const payload = await response.json();
      const batchTokens = payload.tokens ?? payload.nfts ?? [];
      allTokens.push(...batchTokens);
    }

    setNoCacheHeaders(res);
    return res.json({ tokens: allTokens });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch token metadata';
    return res.status(400).json({ error: message });
  }
});

export default router;
