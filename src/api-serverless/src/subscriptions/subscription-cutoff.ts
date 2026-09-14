import { MEMES_CONTRACT, NFTS_TABLE } from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { BadRequestException } from '@/exceptions';
import { sqlExecutor } from '@/sql-executor';

/** Last card closed to subscription changes, including an unreleased mint-day card. */
export async function getSubscriptionCutoffMemeId(
  options?: DbQueryOptions
): Promise<number> {
  // mint_date is a MySQL TIMESTAMP. Read its epoch value so driver/host
  // timezone conversion cannot shift the UTC calendar day. Read the id and
  // timestamp together so NFT ingestion cannot move between the two reads.
  const latest = await sqlExecutor.oneOrNull<{
    id: number;
    mint_timestamp: number | null;
  }>(
    `SELECT id, UNIX_TIMESTAMP(mint_date) AS mint_timestamp
     FROM ${NFTS_TABLE} WHERE contract = :contract ORDER BY id DESC LIMIT 1`,
    { contract: MEMES_CONTRACT },
    options
  );
  const maxMemeId = latest?.id ?? 0;
  const now = new Date();
  const day = now.getUTCDay();
  if (day !== 1 && day !== 3 && day !== 5) {
    return maxMemeId;
  }

  if (latest?.mint_timestamp == null) {
    return maxMemeId;
  }

  // Preserve the existing schedule convention: at most today's unreleased
  // card is inferred. Do not invent missed releases during ingestion outages.
  const latestMintDay = new Date(latest.mint_timestamp * 1000)
    .toISOString()
    .slice(0, 10);
  return latestMintDay < now.toISOString().slice(0, 10)
    ? maxMemeId + 1
    : maxMemeId;
}

export async function assertSubscriptionOpen(
  tokenId: number,
  options?: DbQueryOptions
): Promise<void> {
  if (tokenId <= (await getSubscriptionCutoffMemeId(options))) {
    throw new BadRequestException(
      `Subscriptions are closed for Meme #${tokenId}.`
    );
  }
}
