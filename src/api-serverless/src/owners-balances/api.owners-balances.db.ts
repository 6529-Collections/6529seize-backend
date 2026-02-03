import { constructFilters } from '../api-helpers';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  OWNERS_BALANCES_MEMES_TABLE,
  OWNERS_BALANCES_TABLE,
  WALLETS_TDH_MEMES_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import { fetchLatestTDHBlockNumber, fetchPaginated } from '../../../db-api';
import { sqlExecutor } from '../../../sql-executor';
import { ApiOwnerBalancePage } from '../generated/models/ApiOwnerBalancePage';
import { ApiOwnerBalance } from '../generated/models/ApiOwnerBalance';
import { ApiOwnerBalanceMemes } from '../generated/models/ApiOwnerBalanceMemes';

export const fetchAllOwnerBalances = async (
  page: number,
  pageSize: number,
  sortDir: string
): Promise<ApiOwnerBalancePage> => {
  return fetchPaginated<ApiOwnerBalance>(
    CONSOLIDATED_OWNERS_BALANCES_TABLE,
    {},
    `total_balance ${sortDir}`,
    pageSize,
    page,
    ''
  );
};

export const fetchOwnerBalancesForConsolidationKey = async (
  consolidationKey: string
): Promise<ApiOwnerBalance | null> => {
  const filters = constructFilters(
    '',
    `${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = :consolidation_key`
  );
  const fields = `
    ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.*,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boost,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_memes_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${CONSOLIDATED_WALLETS_TDH_TABLE}.boosted_nextgen_tdh`;

  const joins = ` LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} ON ${CONSOLIDATED_OWNERS_BALANCES_TABLE}.consolidation_key = ${CONSOLIDATED_WALLETS_TDH_TABLE}.consolidation_key`;

  const r = await fetchPaginated(
    CONSOLIDATED_OWNERS_BALANCES_TABLE,
    { consolidation_key: consolidationKey },
    'consolidation_key asc',
    1,
    1,
    filters,
    fields,
    joins
  );

  if (r.data.length !== 1) {
    return null;
  }

  const result = r.data[0];
  const balancesRanksSql = `
    SELECT 
      (SELECT COUNT(DISTINCT consolidation_key) + 1 
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE total_balance > :ownerTotalBalance) AS total_balance_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1 
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE memes_balance > :ownerMemesBalance) AS memes_balance_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1 
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE unique_memes > :ownerUniqueMemes) AS unique_memes_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE gradients_balance > :ownersGradientsBalance) AS gradients_balance_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE nextgen_balance > :ownersNextgenBalance) AS nextgen_balance_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE memelab_balance > :ownersMemelabBalance) AS memelab_balance_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1 
        FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE}
        WHERE unique_memelab > :ownersUniqueMemelab) AS unique_memelab_rank
    FROM dual;
  `;
  const balancesRanks = await sqlExecutor.execute(balancesRanksSql, {
    ownerTotalBalance: result.total_balance,
    ownerMemesBalance: result.memes_balance,
    ownerUniqueMemes: result.unique_memes,
    ownersGradientsBalance: result.gradients_balance,
    ownersNextgenBalance: result.nextgen_balance,
    ownersMemelabBalance: result.memelab_balance,
    ownersUniqueMemelab: result.unique_memelab
  });

  const tdhRanksSql = `
    SELECT 
      (SELECT COUNT(DISTINCT consolidation_key) + 1 
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE boosted_tdh > :ownerBoostedTdh) AS boosted_tdh_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE boosted_memes_tdh > :ownerBoostedMemesTdh) AS boosted_memes_tdh_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE boosted_gradients_tdh > :ownerBoostedGradientsTdh) AS boosted_gradients_tdh_rank,
      (SELECT COUNT(DISTINCT consolidation_key) + 1
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
        WHERE boosted_nextgen_tdh > :ownerBoostedNextgenTdh) AS boosted_nextgen_tdh_rank
    FROM dual;
  `;
  const tdhRanks = await sqlExecutor.execute(tdhRanksSql, {
    ownerBoostedTdh: result.boosted_tdh,
    ownerBoostedMemesTdh: result.boosted_memes_tdh,
    ownerBoostedGradientsTdh: result.boosted_gradients_tdh,
    ownerBoostedNextgenTdh: result.boosted_nextgen_tdh
  });

  return {
    ...result,
    ...balancesRanks[0],
    ...tdhRanks[0]
  };
};

export const fetchOwnerBalancesForWallet = async (wallet: string) => {
  const tdhBlock = await fetchLatestTDHBlockNumber();
  const filters = constructFilters(
    '',
    `${OWNERS_BALANCES_TABLE}.wallet = :wallet`
  );

  const fields = `
    ${OWNERS_BALANCES_TABLE}.*,
    ${WALLETS_TDH_TABLE}.boost,
    ${WALLETS_TDH_TABLE}.boosted_tdh,
    ${WALLETS_TDH_TABLE}.boosted_memes_tdh,
    ${WALLETS_TDH_TABLE}.boosted_gradients_tdh,
    ${WALLETS_TDH_TABLE}.boosted_nextgen_tdh`;

  const joins = ` LEFT JOIN ${WALLETS_TDH_TABLE} ON ${OWNERS_BALANCES_TABLE}.wallet = ${WALLETS_TDH_TABLE}.wallet AND tdh.block = :tdhBlock`;

  const r = await fetchPaginated(
    OWNERS_BALANCES_TABLE,
    { wallet, tdhBlock },
    'wallet asc',
    1,
    1,
    filters,
    fields,
    joins
  );

  if (r.data.length !== 1) {
    return null;
  }

  const result = r.data[0];
  const balancesRanksSql = `
    SELECT 
      (SELECT COUNT(DISTINCT wallet) + 1 
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE total_balance > :ownerTotalBalance) AS total_balance_rank,
      (SELECT COUNT(DISTINCT wallet) + 1 
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE memes_balance > :ownerMemesBalance) AS memes_balance_rank,
      (SELECT COUNT(DISTINCT wallet) + 1 
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE unique_memes > :ownerUniqueMemes) AS unique_memes_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE gradients_balance > :ownersGradientsBalance) AS gradients_balance_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE nextgen_balance > :ownersNextgenBalance) AS nextgen_balance_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE memelab_balance > :ownersMemelabBalance) AS memelab_balance_rank,
      (SELECT COUNT(DISTINCT wallet) + 1 
        FROM ${OWNERS_BALANCES_TABLE}
        WHERE unique_memelab > :ownersUniqueMemelab) AS unique_memelab_rank
    FROM dual;
  `;
  const balancesRanks = await sqlExecutor.execute(balancesRanksSql, {
    ownerTotalBalance: result.total_balance,
    ownerMemesBalance: result.memes_balance,
    ownerUniqueMemes: result.unique_memes,
    ownersGradientsBalance: result.gradients_balance,
    ownersNextgenBalance: result.nextgen_balance,
    ownersMemelabBalance: result.memelab_balance,
    ownersUniqueMemelab: result.unique_memelab
  });

  const tdhRanksSql = `
    SELECT 
      (SELECT COUNT(DISTINCT wallet) + 1 
        FROM ${WALLETS_TDH_TABLE}
        WHERE block=:tdhBlock AND boosted_tdh > :ownerBoostedTdh) AS boosted_tdh_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${WALLETS_TDH_TABLE}
        WHERE block=:tdhBlock AND boosted_memes_tdh > :ownerBoostedMemesTdh) AS boosted_memes_tdh_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${WALLETS_TDH_TABLE}
        WHERE block=:tdhBlock AND boosted_gradients_tdh > :ownerBoostedGradientsTdh) AS boosted_gradients_tdh_rank,
      (SELECT COUNT(DISTINCT wallet) + 1
        FROM ${WALLETS_TDH_TABLE}
        WHERE block=:tdhBlock AND boosted_nextgen_tdh > :ownerBoostedNextgenTdh) AS boosted_nextgen_tdh_rank
    FROM dual;
  `;
  const tdhRanks = await sqlExecutor.execute(tdhRanksSql, {
    ownerBoostedTdh: result.boosted_tdh,
    ownerBoostedMemesTdh: result.boosted_memes_tdh,
    ownerBoostedGradientsTdh: result.boosted_gradients_tdh,
    ownerBoostedNextgenTdh: result.boosted_nextgen_tdh,
    tdhBlock: tdhBlock
  });

  return {
    ...result,
    ...balancesRanks[0],
    ...tdhRanks[0]
  };
};

export async function fetchMemesOwnerBalancesForConsolidationKey(
  consolidationKey: string
): Promise<ApiOwnerBalanceMemes[]> {
  const sql = `
       SELECT  o.*,
            COALESCE(t.boosted_tdh, 0)                           AS boosted_tdh,
            1 + (
                  SELECT COUNT(*)
                  FROM   ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} x
                  WHERE  x.season  = o.season
                    AND  x.balance > o.balance
                )                                               AS 'rank'
    FROM   ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} AS o
    LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE}  AS t
           ON  t.consolidation_key = o.consolidation_key
           AND t.season            = o.season
    WHERE  o.consolidation_key = :consolidation_key
  `;
  return sqlExecutor.execute<ApiOwnerBalanceMemes>(sql, {
    consolidation_key: consolidationKey
  });
}

export async function fetchMemesOwnerBalancesForWallet(wallet: string) {
  const sql = `
    SELECT  o.*,
            COALESCE(t.tdh,          0)                      AS tdh,
            COALESCE(t.boost,        0)                      AS boost,
            COALESCE(t.boosted_tdh,  0)                      AS boosted_tdh,
            COALESCE(t.tdh__raw,     0)                      AS tdh__raw,
            COALESCE(t.tdh_rank,     0)                      AS tdh_rank,
            1 + (
                  SELECT COUNT(*)
                  FROM   ${OWNERS_BALANCES_MEMES_TABLE} x
                         USE INDEX (obm_season_balance_idx)
                  WHERE  x.season  = o.season
                    AND  x.balance > o.balance
                )                                           AS 'rank'
    FROM   ${OWNERS_BALANCES_MEMES_TABLE}  AS o
    LEFT  JOIN ${WALLETS_TDH_MEMES_TABLE}  AS t
           ON  t.wallet = o.wallet
          AND  t.season = o.season
    WHERE  o.wallet = :wallet;
  `;
  return sqlExecutor.execute(sql, { wallet });
}
