import { getRpcUrl } from '@/alchemy';
import { MEMES_CONTRACT } from '@/constants';
import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { ethers } from 'ethers';
import pLimit from 'p-limit';

const logger = Logger.get('MEMES_EDITION_SIZE_FLOOR');

const MANIFOLD_LAZY_CLAIM_CONTRACT =
  '0x26BBEA7803DcAc346D5F5f135b57Cf2c752A02bE';

const MANIFOLD_LAZY_CLAIM_ABI = [
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256 instanceId, tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable paymentReceiver, address erc20, address signingAddress) claim)'
];

const MANIFOLD_CLAIM_FETCH_CONCURRENCY = 10;

export const MEMES_EDITION_SIZE_FLOOR_CAP = 310;

export type MemeEditionSizeMap = Record<number, number>;

type ClaimMaxFetcher = (
  tokenIds: readonly number[],
  provider?: ethers.Provider
) => Promise<Map<number, number>>;

export type ResolveMemeEditionSizeFloorsOptions = {
  actualEditionSizes: MemeEditionSizeMap;
  provider?: ethers.Provider;
  fetchOnChainClaimMaxes?: ClaimMaxFetcher;
};

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = numbers.parseIntOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function getMemeEditionSizeFloor({
  actualEditionSize,
  claimMaxEditionSize
}: {
  actualEditionSize: number;
  claimMaxEditionSize?: number | null;
}): number {
  const actual = normalizePositiveInteger(actualEditionSize) ?? 0;
  const claimMax = normalizePositiveInteger(claimMaxEditionSize);

  if (claimMax === null) {
    return actual;
  }

  return Math.min(claimMax, MEMES_EDITION_SIZE_FLOOR_CAP);
}

export function getCalculationEditionSize({
  supply,
  edition_size_floor
}: {
  supply: number;
  edition_size_floor?: number | null;
}): number {
  return Math.max(
    normalizePositiveInteger(supply) ?? 0,
    normalizePositiveInteger(edition_size_floor) ?? 0
  );
}

export async function resolveMemeEditionSizeFloors({
  actualEditionSizes,
  provider,
  fetchOnChainClaimMaxes = fetchOnChainMemeClaimMaxEditionSizes
}: ResolveMemeEditionSizeFloorsOptions): Promise<MemeEditionSizeMap> {
  const result: MemeEditionSizeMap = {};
  const tokenIds = uniquePositiveTokenIds(
    Object.keys(actualEditionSizes).map(Number)
  );

  if (tokenIds.length === 0) {
    return result;
  }

  const claimMaxes = await safeFetchOnChainClaimMaxes(
    fetchOnChainClaimMaxes,
    tokenIds,
    provider
  );

  for (const tokenId of tokenIds) {
    const claimMaxEditionSize = claimMaxes.get(tokenId);
    if (claimMaxEditionSize === undefined) {
      continue;
    }
    result[tokenId] = getMemeEditionSizeFloor({
      actualEditionSize: actualEditionSizes[tokenId] ?? 0,
      claimMaxEditionSize
    });
  }

  return result;
}

async function safeFetchOnChainClaimMaxes(
  fetcher: ClaimMaxFetcher,
  tokenIds: readonly number[],
  provider: ethers.Provider | undefined
): Promise<Map<number, number>> {
  try {
    return await fetcher(tokenIds, provider);
  } catch (error) {
    logger.warn('Failed to fetch on-chain Meme claim max edition sizes', error);
    return new Map();
  }
}

export async function fetchOnChainMemeClaimMaxEditionSizes(
  tokenIds: readonly number[],
  provider: ethers.Provider = new ethers.JsonRpcProvider(getRpcUrl(1))
): Promise<Map<number, number>> {
  const uniqueTokenIds = uniquePositiveTokenIds(tokenIds);
  const claimMaxes = new Map<number, number>();
  if (uniqueTokenIds.length === 0) {
    return claimMaxes;
  }

  const contract = new ethers.Contract(
    MANIFOLD_LAZY_CLAIM_CONTRACT,
    MANIFOLD_LAZY_CLAIM_ABI,
    provider
  );
  const limit = pLimit(MANIFOLD_CLAIM_FETCH_CONCURRENCY);

  await Promise.all(
    uniqueTokenIds.map((tokenId) =>
      limit(async () => {
        try {
          const [, claim] = await contract.getClaimForToken(
            MEMES_CONTRACT,
            tokenId
          );
          const totalMax = normalizePositiveInteger(claim.totalMax);
          if (totalMax !== null) {
            claimMaxes.set(tokenId, totalMax);
          }
        } catch (error) {
          logger.warn(
            `Failed to fetch Manifold totalMax for Meme #${tokenId}`,
            error
          );
        }
      })
    )
  );

  return claimMaxes;
}

function uniquePositiveTokenIds(tokenIds: readonly number[]): number[] {
  return Array.from(
    new Set(
      tokenIds
        .map((tokenId) => normalizePositiveInteger(tokenId))
        .filter((tokenId): tokenId is number => tokenId !== null)
    )
  ).sort((a, b) => a - b);
}
