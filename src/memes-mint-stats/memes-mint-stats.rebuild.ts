import { MEMES_CONTRACT, NFTS_TABLE } from '@/constants';
import { Logger } from '@/logging';
import {
  insertMemesMintStatsIfMissing,
  isMemesMintStatsEligible
} from '@/memes-mint-stats/memes-mint-stats';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

const logger = Logger.get('MEMES_MINT_STATS_REBUILD');

/**
 * Writes memes_mint_stats as the NFT loop does: for each Memes card in the
 * NFT index whose mint has closed, the loop's writer computes the row from
 * the card's mint date, its paid mints, its redeemed subscriptions and its
 * claim's payment details. Rows that exist are left as they are. Returns
 * the number of rows written.
 */
export async function writeClosedMemesMintStats(
  now: Time = Time.now()
): Promise<number> {
  const cards = await sqlExecutor.execute<{
    id: number | string;
    mint_date: Date | string | null;
  }>(
    `select id, mint_date from ${NFTS_TABLE}
     where lower(contract) = :contract
     order by id asc`,
    { contract: MEMES_CONTRACT.toLowerCase() }
  );
  let written = 0;
  for (const card of cards) {
    if (!card.mint_date) continue;
    const mintDate = new Date(card.mint_date);
    if (
      Number.isNaN(mintDate.getTime()) ||
      !isMemesMintStatsEligible(mintDate, now)
    ) {
      continue;
    }
    if (await insertMemesMintStatsIfMissing(Number(card.id), mintDate)) {
      written++;
    }
  }
  return written;
}

/**
 * Rebuilds memes_mint_stats from empty: every closed mint again, from the
 * NFT index, the transactions, the redeemed subscriptions and the claims.
 */
export async function rebuildMemesMintStats(): Promise<void> {
  const written = await writeClosedMemesMintStats();
  logger.info(`[MEMES_MINT_STATS_REBUILT] [rows ${written}]`);
}
