import { getRpcUrl } from '@/alchemy';
import {
  MANIFOLD_LAZY_CLAIM_ABI,
  MANIFOLD_LAZY_CLAIM_CONTRACT,
  MEMES_CONTRACT,
  MEMES_EDITION_SIZE_FLOOR_CAP
} from '@/constants';
import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { ethers } from 'ethers';
import pLimit from 'p-limit';

const logger = Logger.get('MEMES_EDITION_SIZE_FLOOR');

const MANIFOLD_CLAIM_FETCH_CONCURRENCY = 10;
const MANIFOLD_CLAIM_FETCH_TIMEOUT_MS = Time.seconds(10).toMillis();

export type MemeEditionSizeFloorMap = Record<number, number>;

type ClaimMaxFetcher = (
  tokenIds: readonly number[],
  provider?: ethers.Provider
) => Promise<Map<number, number>>;

export type ResolveMemeEditionSizeFloorsOptions = {
  tokenIds: readonly number[];
  provider?: ethers.Provider;
  fetchOnChainClaimMaxes?: ClaimMaxFetcher;
};

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = numbers.parseIntOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function getMemeEditionSizeFloor(
  claimMaxEditionSize: number
): number | null {
  const claimMax = normalizePositiveInteger(claimMaxEditionSize);

  if (claimMax === null) {
    return null;
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
  tokenIds,
  provider,
  fetchOnChainClaimMaxes = fetchOnChainMemeClaimMaxEditionSizes
}: ResolveMemeEditionSizeFloorsOptions): Promise<MemeEditionSizeFloorMap> {
  const result: MemeEditionSizeFloorMap = {};
  const uniqueTokenIds = uniquePositiveTokenIds(tokenIds);

  if (uniqueTokenIds.length === 0) {
    return result;
  }

  const claimMaxes = await safeFetchOnChainClaimMaxes(
    fetchOnChainClaimMaxes,
    uniqueTokenIds,
    provider
  );

  for (const tokenId of uniqueTokenIds) {
    const claimMaxEditionSize = claimMaxes.get(tokenId);
    if (claimMaxEditionSize === undefined) {
      continue;
    }
    const floor = getMemeEditionSizeFloor(claimMaxEditionSize);
    if (floor !== null) {
      result[tokenId] = floor;
    }
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
          const [, claim] = await withTimeout(
            contract.getClaimForToken(MEMES_CONTRACT, tokenId),
            MANIFOLD_CLAIM_FETCH_TIMEOUT_MS,
            `Timed out fetching Manifold totalMax for Meme #${tokenId}`
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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
