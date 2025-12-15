import { ethers } from 'ethers';
import { Request, Response } from 'express';
import fetch from 'node-fetch';
import { Logger } from '../../../logging';
import { Time } from '../../../time';
import { returnJsonResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();
const logger = Logger.get('ALCHEMY_PROXY');

export default router;

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

function normaliseAddress(address: string | null | undefined): string | null {
  if (!address || !isValidEthAddress(address)) return null;
  try {
    return ethers.utils.getAddress(address);
  } catch {
    return address;
  }
}

function resolveOpenSeaMetadata(
  ...sources: (Record<string, unknown> | null | undefined)[]
): Record<string, unknown> | undefined {
  for (const source of sources) {
    if (!source) continue;
    const metadata =
      (source.openSeaMetadata as Record<string, unknown>) ??
      (source.openseaMetadata as Record<string, unknown>) ??
      (source.openSea as Record<string, unknown>) ??
      (source.opensea as Record<string, unknown>);
    if (metadata) return metadata;
  }
  return undefined;
}

function pickImage(source: Record<string, unknown> | null): string | null {
  if (!source) return null;
  if (source.imageUrl) return source.imageUrl as string;
  const image = source.image as Record<string, unknown> | null;
  if (image?.cachedUrl) return image.cachedUrl as string;
  if (image?.thumbnailUrl) return image.thumbnailUrl as string;
  const media = source.media as Record<string, unknown>[] | null;
  if (media && media.length > 0) {
    const mediaItem = media.find((item) => item?.thumbnailUrl) ?? media[0];
    if (mediaItem?.thumbnailUrl) return mediaItem.thumbnailUrl as string;
    if (mediaItem?.gateway) return mediaItem.gateway as string;
  }
  return null;
}

function pickThumbnail(source: Record<string, unknown> | null): string | null {
  if (!source) return null;
  const image = source.image as Record<string, unknown> | null;
  if (image?.thumbnailUrl) return image.thumbnailUrl as string;
  if (image?.cachedUrl) return image.cachedUrl as string;
  const media = source.media as Record<string, unknown>[] | null;
  if (media && media.length > 0) {
    const mediaItem = media.find((item) => item?.thumbnailUrl) ?? media[0];
    if (mediaItem?.thumbnailUrl) return mediaItem.thumbnailUrl as string;
  }
  return null;
}

function parseFloorPrice(
  meta: Record<string, unknown> | null | undefined
): number | null {
  if (!meta) return null;
  const floorPrice = meta.floorPrice;
  if (typeof floorPrice === 'number') return floorPrice;
  if (floorPrice && typeof floorPrice === 'object') {
    const candidate = (floorPrice as Record<string, unknown>).eth;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function toSafelist(
  status: string | null | undefined
): 'verified' | 'approved' | 'requested' | 'not_requested' | undefined {
  if (!status) return undefined;
  if (['verified', 'approved', 'requested', 'not_requested'].includes(status)) {
    return status as 'verified' | 'approved' | 'requested' | 'not_requested';
  }
  return undefined;
}

interface Suggestion {
  address: string;
  name?: string;
  symbol?: string;
  tokenType?: 'ERC721' | 'ERC1155';
  totalSupply?: string;
  floorPriceEth?: number | null;
  imageUrl?: string | null;
  isSpam?: boolean;
  safelist?: 'verified' | 'approved' | 'requested' | 'not_requested';
  deployer?: string | null;
}

function extractContract(contract: Record<string, unknown>): Suggestion | null {
  const baseMeta =
    (contract.contractMetadata as Record<string, unknown>) ?? contract;
  const openSea = resolveOpenSeaMetadata(contract, baseMeta);
  const address =
    normaliseAddress(
      (contract.address as string) ?? (contract.contractAddress as string)
    ) ?? normaliseAddress(baseMeta?.address as string | undefined);

  if (!address) return null;

  const name =
    (baseMeta?.name as string | undefined) ??
    (openSea?.collectionName as string | undefined) ??
    undefined;
  const tokenType = (baseMeta?.tokenType as string | undefined)?.toUpperCase();
  const imageUrl = pickImage({
    imageUrl: openSea?.imageUrl ?? null,
    image: baseMeta?.image ?? null
  } as Record<string, unknown>);
  const spamInfo = (contract.spamInfo ?? baseMeta?.spamInfo) as
    | Record<string, unknown>
    | undefined;
  const isSpam =
    (contract.isSpam as boolean | undefined) ??
    spamInfo?.isSpam ??
    (baseMeta?.isSpam as boolean | undefined) ??
    false;
  const safelist = toSafelist(
    openSea?.safelistRequestStatus as string | undefined
  );
  const floorPriceEth = parseFloorPrice(openSea ?? null);
  const deployer = normaliseAddress(
    (contract.contractDeployer as string | undefined) ??
      (baseMeta?.contractDeployer as string | undefined)
  );

  return {
    address,
    name,
    symbol: baseMeta?.symbol as string | undefined,
    tokenType:
      tokenType === 'ERC721' || tokenType === 'ERC1155' ? tokenType : undefined,
    totalSupply: baseMeta?.totalSupply as string | undefined,
    floorPriceEth,
    imageUrl,
    isSpam: isSpam as boolean,
    safelist,
    deployer
  };
}

interface TokenMetadata {
  tokenId: string;
  tokenIdRaw: string;
  contract?: string;
  name: string | null;
  imageUrl: string | null;
  collectionName: string | null;
  isSpam: boolean;
}

function normaliseTokenMetadata(
  token: Record<string, unknown>
): TokenMetadata | null {
  const tokenIdRaw = (token.tokenId as string) ?? '';
  try {
    const tokenIdBigInt = BigInt(tokenIdRaw);

    const imageUrl = pickThumbnail({
      image: token.image as Record<string, unknown> | null,
      media: token.media as Record<string, unknown>[] | null
    } as Record<string, unknown>);

    const contractData = token.contract as Record<string, unknown> | null;
    const metadata = token.metadata as Record<string, unknown> | null;
    const raw = token.raw as Record<string, unknown> | null;
    const rawMetadata = raw?.metadata as Record<string, unknown> | null;
    const collection = token.collection as Record<string, unknown> | null;
    const spamInfo = token.spamInfo as Record<string, unknown> | null;

    return {
      tokenId: tokenIdBigInt.toString(),
      tokenIdRaw,
      contract: contractData?.address as string | undefined,
      name:
        (token.title as string | null) ??
        (token.name as string | null) ??
        (metadata?.name as string | null) ??
        (rawMetadata?.name as string | null) ??
        null,
      imageUrl,
      collectionName:
        (collection?.name as string | null) ??
        ((contractData?.openSeaMetadata as Record<string, unknown> | null)
          ?.collectionName as string | null) ??
        (contractData?.name as string | null) ??
        null,
      isSpam:
        (token.isSpam as boolean | undefined) ??
        (spamInfo?.isSpam as boolean | undefined) ??
        false
    };
  } catch {
    return null;
  }
}

function getAlchemyApiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error('ALCHEMY_API_KEY environment variable is required');
  }
  return key;
}

function setNoCacheHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

router.get(
  '/collections',
  cacheRequest({ ttl: Time.minutes(5) }),
  async function (
    req: Request<
      Record<string, never>,
      unknown,
      unknown,
      {
        query?: string;
        chain?: string;
        hideSpam?: string;
        pageKey?: string;
      }
    >,
    res: Response
  ) {
    const query = req.query.query?.trim();
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const apiKey = getAlchemyApiKey();
    const chain = req.query.chain ?? 'ethereum';
    const hideSpam =
      req.query.hideSpam !== '0' && req.query.hideSpam !== 'false';
    const pageKey = req.query.pageKey;

    const network = resolveNetwork(chain);
    const url = new URL(
      `https://${network}.g.alchemy.com/nft/v3/${apiKey}/searchContractMetadata`
    );
    url.searchParams.set('query', query);
    if (pageKey) url.searchParams.set('pageKey', pageKey);

    logger.info(`[COLLECTIONS] Searching for query: ${query}`);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      logger.error(
        `[COLLECTIONS] Failed to search NFT collections: ${response.status}`
      );
      return res
        .status(400)
        .json({ error: 'Failed to search NFT collections' });
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const contracts = (payload?.contracts as Record<string, unknown>[]) ?? [];

    const suggestions = contracts
      .map((contract) => extractContract(contract))
      .filter((s): s is Suggestion => s !== null);

    const hiddenCount = hideSpam
      ? suggestions.filter((s) => s.isSpam).length
      : 0;
    const visibleItems = hideSpam
      ? suggestions.filter((s) => !s.isSpam)
      : suggestions;

    logger.info(
      `[COLLECTIONS] Found ${visibleItems.length} collections (hidden: ${hiddenCount})`
    );

    setNoCacheHeaders(res);
    return await returnJsonResult(
      {
        items: visibleItems,
        hiddenCount,
        nextPageKey: payload?.pageKey as string | undefined
      },
      req,
      res
    );
  }
);

router.get(
  '/contract',
  cacheRequest({ ttl: Time.minutes(10) }),
  async function (
    req: Request<
      Record<string, never>,
      unknown,
      unknown,
      {
        address?: string;
        chain?: string;
      }
    >,
    res: Response
  ) {
    const address = req.query.address;
    if (!address || !isValidEthAddress(address)) {
      return res.status(400).json({ error: 'address is required' });
    }

    const checksum = normaliseAddress(address);
    if (!checksum) {
      setNoCacheHeaders(res);
      return await returnJsonResult(null, req, res);
    }

    const apiKey = getAlchemyApiKey();
    const chain = req.query.chain ?? 'ethereum';
    const network = resolveNetwork(chain);
    const url = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getContractMetadata?contractAddress=${checksum}`;

    logger.info(`[CONTRACT] Fetching metadata for: ${checksum}`);

    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });

    if (response.status === 404) {
      logger.info(`[CONTRACT] Contract not found: ${checksum}`);
      setNoCacheHeaders(res);
      return await returnJsonResult(null, req, res);
    }

    if (!response.ok) {
      logger.error(
        `[CONTRACT] Failed to fetch contract metadata: ${response.status}`
      );
      return res
        .status(400)
        .json({ error: 'Failed to fetch contract metadata' });
    }

    const payload = (await response.json()) as Record<string, unknown> | null;
    if (!payload) {
      setNoCacheHeaders(res);
      return await returnJsonResult(null, req, res);
    }

    const baseMeta =
      (payload.contractMetadata as Record<string, unknown>) ?? payload;
    const openSeaMetadata = resolveOpenSeaMetadata(
      payload,
      payload.contractMetadata as Record<string, unknown> | undefined,
      baseMeta
    );

    const spamInfo = (payload.spamInfo ?? baseMeta?.spamInfo) as
      | Record<string, unknown>
      | undefined;

    const contract = {
      ...baseMeta,
      contractMetadata: baseMeta,
      address: checksum,
      contractAddress: checksum,
      openSeaMetadata,
      isSpam:
        (payload.isSpam as boolean | undefined) ??
        (baseMeta.isSpam as boolean | undefined) ??
        spamInfo?.isSpam
    } as Record<string, unknown>;

    const suggestion = extractContract(contract);
    if (!suggestion) {
      setNoCacheHeaders(res);
      return await returnJsonResult(null, req, res);
    }

    logger.info(`[CONTRACT] Successfully fetched: ${checksum}`);

    setNoCacheHeaders(res);
    return await returnJsonResult(
      {
        ...suggestion,
        description: (openSeaMetadata?.description as string | null) ?? null,
        bannerImageUrl:
          (openSeaMetadata?.bannerImageUrl as string | null) ?? null
      },
      req,
      res
    );
  }
);

router.get(
  '/owner-nfts',
  cacheRequest({ ttl: Time.minutes(1) }),
  async function (
    req: Request<
      Record<string, never>,
      unknown,
      unknown,
      {
        chainId?: string;
        contract?: string;
        owner?: string;
        pageKey?: string;
      }
    >,
    res: Response
  ) {
    const chainIdRaw = req.query.chainId;
    const contract = req.query.contract;
    const owner = req.query.owner;
    const pageKey = req.query.pageKey;

    const chainId = Number(chainIdRaw);
    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: 'chainId is required' });
    }
    if (!contract || !owner) {
      return res.status(400).json({ error: 'contract and owner are required' });
    }

    const apiKey = getAlchemyApiKey();
    const network = resolveNetworkByChainId(chainId);
    const baseUrl = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner?owner=${owner}&contractAddresses[]=${contract}`;

    logger.info(`[OWNER-NFTS] Fetching NFTs for owner: ${owner}`);

    const allNfts: Record<string, unknown>[] = [];
    let nextPageKey = pageKey;
    let attempts = 0;
    const MAX_RETRIES = 3;

    while (true) {
      let url = baseUrl;
      if (nextPageKey) url += `&pageKey=${nextPageKey}`;

      const response = await fetch(url, {
        headers: { accept: 'application/json' }
      });
      const data = (await response.json()) as Record<string, unknown>;

      if (data.error) {
        if (attempts >= MAX_RETRIES) {
          logger.error(
            `[OWNER-NFTS] Failed to fetch NFTs after ${MAX_RETRIES} retries`
          );
          return res
            .status(400)
            .json({ error: 'Failed to fetch NFTs for owner after retries' });
        }
        attempts++;
        logger.warn(`[OWNER-NFTS] Retry attempt ${attempts}`);
        await new Promise((resolve) => setTimeout(resolve, 250 * attempts));
        continue;
      }

      allNfts.push(...((data.ownedNfts as Record<string, unknown>[]) ?? []));

      if (!data.pageKey) break;
      nextPageKey = data.pageKey as string;
    }

    const result = allNfts.map((nft) => ({
      tokenId: nft.tokenId,
      tokenType: nft.tokenType,
      name: nft.name,
      tokenUri: nft.tokenUri,
      image: nft.image
    }));

    logger.info(`[OWNER-NFTS] Found ${result.length} NFTs`);

    setNoCacheHeaders(res);
    return await returnJsonResult(result, req, res);
  }
);

type TokenFetchInput = { contract: string; tokenId: string };

function parseTokensFromRequest(body: {
  address?: string;
  tokenIds?: string[];
  tokens?: TokenFetchInput[];
}): { tokens: TokenFetchInput[]; error?: string; emptyResult?: boolean } {
  const { address, tokenIds, tokens } = body;

  if (tokens && tokens.length > 0) {
    return { tokens: [...tokens] };
  }

  if (!address || !Array.isArray(tokenIds) || tokenIds.length === 0) {
    return {
      tokens: [],
      error: 'Either tokens OR (address and tokenIds) are required'
    };
  }

  if (!isValidEthAddress(address)) {
    return { tokens: [], error: 'Invalid contract address' };
  }

  const checksum = normaliseAddress(address);
  if (!checksum) {
    return { tokens: [], emptyResult: true };
  }

  return {
    tokens: tokenIds.map((tokenId: string) => ({ contract: checksum, tokenId }))
  };
}

async function fetchMetadataBatch(
  url: string,
  tokens: TokenFetchInput[]
): Promise<{ results: TokenMetadata[]; error?: string }> {
  const body = {
    tokens: tokens.map((t) => ({
      contractAddress: t.contract,
      tokenId: t.tokenId
    }))
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    logger.error(
      `[TOKEN-METADATA] Failed to fetch token metadata: ${response.status}`
    );
    return { results: [], error: 'Failed to fetch token metadata' };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const tokenResults =
    (payload.tokens as Record<string, unknown>[]) ??
    (payload.nfts as Record<string, unknown>[]) ??
    [];

  const results = tokenResults
    .map((token) => normaliseTokenMetadata(token))
    .filter((t): t is TokenMetadata => t !== null);

  return { results };
}

router.post(
  '/token-metadata',
  async function (
    req: Request<
      Record<string, never>,
      unknown,
      {
        address?: string;
        tokenIds?: string[];
        tokens?: { contract: string; tokenId: string }[];
        chain?: string;
      }
    >,
    res: Response
  ) {
    const { chain = 'ethereum', ...rest } = req.body ?? {};
    const parsed = parseTokensFromRequest(rest);

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    if (parsed.emptyResult) {
      setNoCacheHeaders(res);
      return await returnJsonResult([], req, res);
    }

    const tokensToFetch = parsed.tokens;
    logger.info(
      `[TOKEN-METADATA] Fetching metadata for ${tokensToFetch.length} tokens`
    );

    const apiKey = getAlchemyApiKey();
    const network = resolveNetwork(chain);
    const url = `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadataBatch`;
    const results: TokenMetadata[] = [];
    const MAX_BATCH_SIZE = 100;

    for (let i = 0; i < tokensToFetch.length; i += MAX_BATCH_SIZE) {
      const slice = tokensToFetch.slice(i, i + MAX_BATCH_SIZE);
      const batch = await fetchMetadataBatch(url, slice);
      if (batch.error) {
        return res.status(400).json({ error: batch.error });
      }
      results.push(...batch.results);
    }

    logger.info(
      `[TOKEN-METADATA] Successfully fetched ${results.length} tokens`
    );
    setNoCacheHeaders(res);
    return await returnJsonResult(results, req, res);
  }
);
