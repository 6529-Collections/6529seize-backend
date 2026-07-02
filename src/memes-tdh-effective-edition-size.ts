import { getRpcUrl } from '@/alchemy';
import { MEMES_CONTRACT, MINTING_CLAIMS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { sqlExecutor } from '@/sql-executor';
import { ethers } from 'ethers';

const logger = Logger.get('MEMES_TDH_EFFECTIVE_EDITION_SIZE');

const MANIFOLD_LAZY_CLAIM_CONTRACT =
  '0x26BBEA7803DcAc346D5F5f135b57Cf2c752A02bE';

const MANIFOLD_LAZY_CLAIM_ABI = [
  'function getClaimForToken(address creatorContractAddress, uint256 tokenId) view returns (uint256 instanceId, tuple(uint32 total, uint32 totalMax, uint32 walletMax, uint48 startDate, uint48 endDate, uint8 storageProtocol, bytes32 merkleRoot, string location, uint256 tokenId, uint256 cost, address payable paymentReceiver, address erc20, address signingAddress) claim)'
];

export const MEMES_EFFECTIVE_EDITION_SIZE_THRESHOLD = 300;
export const MEMES_RESEARCH_TARGET_EDITION_SIZE = 310;

export type MemeEditionSizeMap = Record<number, number>;

type ClaimMaxFetcher = (
  tokenIds: readonly number[],
  blockTag?: number
) => Promise<Map<number, number>>;

export type ResolveEffectiveMemeEditionSizesOptions = {
  actualEditionSizes: MemeEditionSizeMap;
  blockTag?: number;
  fetchOnChainClaimMaxes?: ClaimMaxFetcher;
  fetchDbClaimMaxes?: ClaimMaxFetcher;
};

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = numbers.parseIntOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function getEffectiveMemeEditionSize({
  actualEditionSize,
  claimMaxEditionSize
}: {
  actualEditionSize: number;
  claimMaxEditionSize?: number | null;
}): number {
  const actual = normalizePositiveInteger(actualEditionSize) ?? 0;
  if (actual >= MEMES_EFFECTIVE_EDITION_SIZE_THRESHOLD) {
    return actual;
  }

  const claimMax = normalizePositiveInteger(claimMaxEditionSize);
  if (claimMax === null) {
    return actual;
  }

  return Math.max(
    actual,
    Math.min(claimMax, MEMES_RESEARCH_TARGET_EDITION_SIZE)
  );
}

export async function resolveEffectiveMemeEditionSizes({
  actualEditionSizes,
  blockTag,
  fetchOnChainClaimMaxes = fetchOnChainMemeClaimMaxEditionSizes,
  fetchDbClaimMaxes = fetchDbMemeClaimMaxEditionSizes
}: ResolveEffectiveMemeEditionSizesOptions): Promise<MemeEditionSizeMap> {
  const result: MemeEditionSizeMap = { ...actualEditionSizes };
  const candidateTokenIds = Object.entries(actualEditionSizes)
    .map(([tokenId, actualEditionSize]) => ({
      tokenId: Number(tokenId),
      actualEditionSize
    }))
    .filter(
      ({ tokenId, actualEditionSize }) =>
        Number.isInteger(tokenId) &&
        tokenId > 0 &&
        (normalizePositiveInteger(actualEditionSize) ?? 0) <
          MEMES_EFFECTIVE_EDITION_SIZE_THRESHOLD
    )
    .map(({ tokenId }) => tokenId);

  if (candidateTokenIds.length === 0) {
    return result;
  }

  const [onChainClaimMaxes, dbClaimMaxes] = await Promise.all([
    safeFetchClaimMaxes(
      fetchOnChainClaimMaxes,
      candidateTokenIds,
      blockTag,
      'on-chain'
    ),
    safeFetchClaimMaxes(fetchDbClaimMaxes, candidateTokenIds, undefined, 'db')
  ]);

  for (const tokenId of candidateTokenIds) {
    result[tokenId] = getEffectiveMemeEditionSize({
      actualEditionSize: actualEditionSizes[tokenId] ?? 0,
      claimMaxEditionSize:
        onChainClaimMaxes.get(tokenId) ?? dbClaimMaxes.get(tokenId) ?? null
    });
  }

  return result;
}

async function safeFetchClaimMaxes(
  fetcher: ClaimMaxFetcher,
  tokenIds: readonly number[],
  blockTag: number | undefined,
  source: string
): Promise<Map<number, number>> {
  try {
    return await fetcher(tokenIds, blockTag);
  } catch (error) {
    logger.warn(
      `Failed to fetch ${source} Meme claim max edition sizes`,
      error
    );
    return new Map();
  }
}

export async function fetchOnChainMemeClaimMaxEditionSizes(
  tokenIds: readonly number[],
  blockTag?: number
): Promise<Map<number, number>> {
  const uniqueTokenIds = uniquePositiveTokenIds(tokenIds);
  const claimMaxes = new Map<number, number>();
  if (uniqueTokenIds.length === 0) {
    return claimMaxes;
  }

  const provider = new ethers.JsonRpcProvider(getRpcUrl(1));
  const contract = new ethers.Contract(
    MANIFOLD_LAZY_CLAIM_CONTRACT,
    MANIFOLD_LAZY_CLAIM_ABI,
    provider
  );
  const overrides = blockTag === undefined ? undefined : { blockTag };

  await Promise.all(
    uniqueTokenIds.map(async (tokenId) => {
      try {
        const [, claim] = overrides
          ? await contract.getClaimForToken(MEMES_CONTRACT, tokenId, overrides)
          : await contract.getClaimForToken(MEMES_CONTRACT, tokenId);
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
  );

  return claimMaxes;
}

export async function fetchDbMemeClaimMaxEditionSizes(
  tokenIds: readonly number[]
): Promise<Map<number, number>> {
  const uniqueTokenIds = uniquePositiveTokenIds(tokenIds);
  const claimMaxes = new Map<number, number>();
  if (uniqueTokenIds.length === 0) {
    return claimMaxes;
  }

  const rows = await sqlExecutor.execute<{
    claim_id: number | string;
    edition_size: number | string | null;
  }>(
    `SELECT claim_id, edition_size
     FROM ${MINTING_CLAIMS_TABLE}
     WHERE contract = :contract
       AND claim_id IN (:tokenIds)
       AND edition_size IS NOT NULL`,
    {
      contract: MEMES_CONTRACT.toLowerCase(),
      tokenIds: uniqueTokenIds
    }
  );

  for (const row of rows) {
    const tokenId = normalizePositiveInteger(row.claim_id);
    const editionSize = normalizePositiveInteger(row.edition_size);
    if (tokenId !== null && editionSize !== null) {
      claimMaxes.set(tokenId, editionSize);
    }
  }

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
