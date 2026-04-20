import {
  MANIFOLD,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { getDataSource } from '@/db';
import { MemesMintStat } from '@/entities/IMemesMintStat';
import { fetchPaymentDetailsForMemeToken } from '@/memes-mint-stats/payment-details';
import { sqlExecutor } from '@/sql-executor';

const ARTIST_SPLIT_RATIO = 0.5;

type MintTransactionRow = {
  token_count: number | string | null;
  eth_price_usd: number | string | null;
};

type RedeemedAggregateRow = {
  redeemedCount: number | string | null;
  redeemedUsdPrice: number | string | null;
};

function roundUsd(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export async function calculateMemesMintStats(
  tokenId: number,
  mintDate: Date
): Promise<MemesMintStat> {
  const paymentDetails = await fetchPaymentDetailsForMemeToken(tokenId);
  const mintTransactions = await sqlExecutor.execute<MintTransactionRow>(
    `SELECT token_count, eth_price_usd
    FROM ${TRANSACTIONS_TABLE}
    WHERE contract = '${MEMES_CONTRACT}'
      AND token_id = :tokenId
      AND from_address IN ('${NULL_ADDRESS}', '${MANIFOLD}')
      AND to_address NOT IN ('${NULL_ADDRESS}', '${MANIFOLD}')
      AND value > 0`,
    { tokenId }
  );

  const nonZeroEthUsd = mintTransactions
    .map((tx) => Number(tx.eth_price_usd ?? 0))
    .filter((value) => value > 0);
  const fallbackEthUsd =
    nonZeroEthUsd.length > 0
      ? nonZeroEthUsd.reduce((sum, value) => sum + value, 0) /
        nonZeroEthUsd.length
      : 0;

  const redeemedAgg = await sqlExecutor.oneOrNull<RedeemedAggregateRow>(
    `SELECT
      COALESCE(SUM(rs.count), 0) AS redeemedCount,
      COALESCE(
        SUM(
          rs.count * :mintPrice * COALESCE(NULLIF(t.eth_price_usd, 0), :fallbackEthUsd)
        ),
        0
      ) AS redeemedUsdPrice
    FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} rs
    LEFT JOIN ${TRANSACTIONS_TABLE} t
      ON t.transaction = rs.transaction
      AND t.contract = rs.contract
      AND t.token_id = rs.token_id
      AND LOWER(t.to_address) = LOWER(rs.address)
    WHERE rs.contract = '${MEMES_CONTRACT}'
      AND rs.token_id = :tokenId`,
    {
      tokenId,
      mintPrice: MEMES_MINT_PRICE,
      fallbackEthUsd
    }
  );

  const mintCount = mintTransactions.reduce(
    (sum, tx) => sum + Number(tx.token_count ?? 0),
    0
  );
  const mintedUsdPrice = mintTransactions.reduce((sum, tx) => {
    const ethUsdRaw = Number(tx.eth_price_usd ?? 0);
    const ethUsd = ethUsdRaw > 0 ? ethUsdRaw : fallbackEthUsd;
    return sum + Number(tx.token_count ?? 0) * MEMES_MINT_PRICE * ethUsd;
  }, 0);

  const subscriptionsCount = Number(redeemedAgg?.redeemedCount ?? 0);
  const redeemedUsdPrice = Number(redeemedAgg?.redeemedUsdPrice ?? 0);
  const totalCount = mintCount + subscriptionsCount;
  const proceedsEth = totalCount * MEMES_MINT_PRICE;
  const proceedsUsd = roundUsd(mintedUsdPrice + redeemedUsdPrice);
  const artistSplitEth = proceedsEth * ARTIST_SPLIT_RATIO;
  const artistSplitUsd = roundUsd(proceedsUsd * ARTIST_SPLIT_RATIO);

  return {
    id: tokenId,
    mint_date: mintDate,
    total_count: totalCount,
    mint_count: mintCount,
    subscriptions_count: subscriptionsCount,
    proceeds_eth: proceedsEth,
    proceeds_usd: proceedsUsd,
    artist_split_eth: artistSplitEth,
    artist_split_usd: artistSplitUsd,
    payment_details: paymentDetails
  };
}

export async function insertMemesMintStatsIfMissing(
  tokenId: number,
  mintDate: Date
): Promise<MemesMintStat | null> {
  const repo = getDataSource().getRepository(MemesMintStat);
  const exists = await repo.existsBy({ id: tokenId });
  if (exists) {
    return null;
  }

  const payload = await calculateMemesMintStats(tokenId, mintDate);
  const insertResult = await repo
    .createQueryBuilder()
    .insert()
    .into(MemesMintStat)
    .values(payload)
    .orIgnore()
    .execute();

  const wasInserted =
    insertResult?.raw !== undefined &&
    'affectedRows' in insertResult.raw &&
    Number(insertResult.raw.affectedRows) > 0;
  return wasInserted ? payload : null;
}
