import { ConsolidatedTDH, TDHENS } from './entities/ITDH';
import {
  retrieveWalletConsolidations,
  fetchAllTDH,
  fetchAllNFTs,
  persistConsolidatedTDH,
  fetchConsolidationDisplay,
  fetchLatestTDHBlockNumber
} from './db';
import { areEqualAddresses } from './helpers';
import { calculateBoosts, calculateRanks } from './tdh';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  SZN1_INDEX,
  SZN2_INDEX,
  SZN3_INDEX,
  SZN4_INDEX,
  SZN5_INDEX,
  SZN6_INDEX
} from './constants';
import { sqlExecutor } from './sql-executor';
import { Logger } from './logging';

const logger = Logger.get('TDH_CONSOLIDATION');

export async function getWalletTdhAndConsolidatedWallets(
  wallet: string
): Promise<{
  tdh: number;
  consolidatedWallets: string[];
  blockNo: number;
  consolidation_key: string | null;
  consolidation_display: string | null;
}> {
  if (!wallet.match(/0x[a-fA-F0-9]{40}/)) {
    return {
      tdh: 0,
      consolidatedWallets: [],
      blockNo: 0,
      consolidation_display: null,
      consolidation_key: null
    };
  }
  const tdhSqlResult = await sqlExecutor.execute(
    `SELECT consolidation_key, consolidation_display, block, boosted_tdh as tdh, wallets FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE LOWER(consolidation_key) LIKE :wallet`,
    { wallet: `%${wallet.toLowerCase()}%` }
  );
  const row = tdhSqlResult?.at(0);
  const consolidatedWallets = JSON.parse(row?.wallets ?? '[]').map(
    (w: string) => w.toLowerCase()
  );
  if (!consolidatedWallets.includes(wallet.toLowerCase())) {
    consolidatedWallets.push(wallet.toLowerCase());
  }
  return {
    consolidation_key: row?.consolidation_key ?? null,
    consolidation_display: row?.consolidation_display ?? null,
    tdh: row?.tdh ?? 0,
    consolidatedWallets: consolidatedWallets,
    blockNo: row?.block ?? 0
  };
}

export async function getAllTdhs(): Promise<
  { tdh: number; wallets: string[] }[]
> {
  return sqlExecutor
    .execute(`select tdh, wallets from ${CONSOLIDATED_WALLETS_TDH_TABLE}`)
    .then((rows) =>
      rows.map((row: any) => ({
        ...row,
        wallets: JSON.parse(row.wallets).map((it: string) => it.toLowerCase())
      }))
    );
}

export async function consolidateTDHForWallets(
  tdh: TDHENS[],
  MEMES_COUNT: number
) {
  const consolidatedTdh: ConsolidatedTDH[] = [];
  const processedWallets = new Set<string>();
  const allGradientsTDH: any[] = [];

  for (const tdhEntry of tdh) {
    const wallet = tdhEntry.wallet;
    const consolidations = await retrieveWalletConsolidations(wallet);
    const display = await fetchConsolidationDisplay(consolidations);
    const consolidationKey = [...consolidations].sort().join('-');

    if (
      !Array.from(processedWallets).some((pw) => areEqualAddresses(wallet, pw))
    ) {
      const consolidatedWalletsTdh = [...tdh].filter((t) =>
        consolidations.some((c) => areEqualAddresses(c, t.wallet))
      );

      let totalTDH = 0;
      let totalTDH__raw = 0;
      let totalBalance = 0;
      let genesis = false;
      let memesTDH = 0;
      let memesTDH__raw = 0;
      let memesBalance = 0;
      let memes_tdh_season1 = 0;
      let memes_tdh_season1__raw = 0;
      let memes_balance_season1 = 0;
      let memes_tdh_season2 = 0;
      let memes_tdh_season2__raw = 0;
      let memes_balance_season2 = 0;
      let memes_tdh_season3 = 0;
      let memes_tdh_season3__raw = 0;
      let memes_balance_season3 = 0;
      let memes_tdh_season4 = 0;
      let memes_tdh_season4__raw = 0;
      let memes_balance_season4 = 0;
      let memes_tdh_season5 = 0;
      let memes_tdh_season5__raw = 0;
      let memes_balance_season5 = 0;
      let memes_tdh_season6 = 0;
      let memes_tdh_season6__raw = 0;
      let memes_balance_season6 = 0;
      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;
      let gradientsBalance = 0;
      let consolidationMemes: any[] = [];
      let consolidationGradients: any[] = [];

      consolidatedWalletsTdh.forEach((wTdh) => {
        totalTDH += wTdh.tdh;
        totalTDH__raw += wTdh.tdh__raw;
        totalBalance += wTdh.balance;
        genesis = genesis || wTdh.genesis;
        memesTDH += wTdh.memes_tdh;
        memesTDH__raw += wTdh.memes_tdh__raw;
        memesBalance += wTdh.memes_balance;
        memes_tdh_season1 += wTdh.memes_tdh_season1;
        memes_tdh_season1__raw += wTdh.memes_tdh_season1__raw;
        memes_balance_season1 += wTdh.memes_balance_season1;
        memes_tdh_season2 += wTdh.memes_tdh_season2;
        memes_tdh_season2__raw += wTdh.memes_tdh_season2__raw;
        memes_balance_season2 += wTdh.memes_balance_season2;
        memes_tdh_season3 += wTdh.memes_tdh_season3;
        memes_tdh_season3__raw += wTdh.memes_tdh_season3__raw;
        memes_balance_season3 += wTdh.memes_balance_season3;
        memes_tdh_season4 += wTdh.memes_tdh_season4;
        memes_tdh_season4__raw += wTdh.memes_tdh_season4__raw;
        memes_balance_season4 += wTdh.memes_balance_season4;
        memes_tdh_season5 += wTdh.memes_tdh_season5;
        memes_tdh_season5__raw += wTdh.memes_tdh_season5__raw;
        memes_balance_season5 += wTdh.memes_balance_season5;
        memes_tdh_season6 += wTdh.memes_tdh_season6;
        memes_tdh_season6__raw += wTdh.memes_tdh_season6__raw;
        memes_balance_season6 += wTdh.memes_balance_season6;
        gradientsTDH += wTdh.gradients_tdh;
        gradientsTDH__raw += wTdh.gradients_tdh__raw;
        gradientsBalance += wTdh.gradients_balance;
        consolidationMemes = consolidateCards(consolidationMemes, wTdh.memes);
        consolidationGradients = consolidateCards(
          consolidationGradients,
          wTdh.gradients
        );
      });

      let memesCardSets = 0;
      if (consolidationMemes.length == MEMES_COUNT) {
        memesCardSets = Math.min.apply(
          Math,
          [...consolidationMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const unique_memes = consolidationMemes.length;
      const unique_memes_season1 = getUniqueMemesSeason(1, consolidationMemes);
      const unique_memes_season2 = getUniqueMemesSeason(2, consolidationMemes);
      const unique_memes_season3 = getUniqueMemesSeason(3, consolidationMemes);
      const unique_memes_season4 = getUniqueMemesSeason(4, consolidationMemes);
      const unique_memes_season5 = getUniqueMemesSeason(5, consolidationMemes);
      const unique_memes_season6 = getUniqueMemesSeason(6, consolidationMemes);

      const consolidation: ConsolidatedTDH = {
        date: new Date(),
        consolidation_display: display,
        consolidation_key: consolidationKey,
        wallets: consolidations,
        tdh_rank: 0, //assigned later
        tdh_rank_memes: 0, //assigned later
        tdh_rank_memes_szn1: 0, //assigned later
        tdh_rank_memes_szn2: 0, //assigned later
        tdh_rank_memes_szn3: 0, //assigned later
        tdh_rank_memes_szn4: 0, //assigned later
        tdh_rank_memes_szn5: 0, //assigned later
        tdh_rank_memes_szn6: 0, //assigned later
        tdh_rank_gradients: 0, //assigned later
        block: tdhEntry.block,
        tdh: totalTDH,
        boost: 0,
        boosted_tdh: 0,
        tdh__raw: totalTDH__raw,
        balance: totalBalance,
        memes_cards_sets: memesCardSets,
        genesis: genesis,
        unique_memes: unique_memes,
        unique_memes_season1: unique_memes_season1,
        unique_memes_season2: unique_memes_season2,
        unique_memes_season3: unique_memes_season3,
        unique_memes_season4: unique_memes_season4,
        unique_memes_season5: unique_memes_season5,
        unique_memes_season6: unique_memes_season6,
        boosted_memes_tdh: 0,
        memes_tdh: memesTDH,
        memes_tdh__raw: memesTDH__raw,
        memes_balance: memesBalance,
        boosted_memes_tdh_season1: 0,
        memes_tdh_season1: memes_tdh_season1,
        memes_tdh_season1__raw: memes_tdh_season1__raw,
        memes_balance_season1: memes_balance_season1,
        boosted_memes_tdh_season2: 0,
        memes_tdh_season2: memes_tdh_season2,
        memes_tdh_season2__raw: memes_tdh_season2__raw,
        memes_balance_season2: memes_balance_season2,
        boosted_memes_tdh_season3: 0,
        memes_tdh_season3: memes_tdh_season3,
        memes_tdh_season3__raw: memes_tdh_season3__raw,
        memes_balance_season3: memes_balance_season3,
        boosted_memes_tdh_season4: 0,
        memes_tdh_season4: memes_tdh_season4,
        memes_tdh_season4__raw: memes_tdh_season4__raw,
        memes_balance_season4: memes_balance_season4,
        boosted_memes_tdh_season5: 0,
        memes_tdh_season5: memes_tdh_season5,
        memes_tdh_season5__raw: memes_tdh_season5__raw,
        memes_balance_season5: memes_balance_season5,
        boosted_memes_tdh_season6: 0,
        memes_tdh_season6: memes_tdh_season6,
        memes_tdh_season6__raw: memes_tdh_season6__raw,
        memes_balance_season6: memes_balance_season6,
        memes: consolidationMemes,
        memes_ranks: [],
        boosted_gradients_tdh: 0,
        gradients_tdh: gradientsTDH,
        gradients_tdh__raw: gradientsTDH__raw,
        gradients_balance: gradientsBalance,
        gradients: consolidationGradients,
        gradients_ranks: []
      };
      consolidationGradients.forEach((wg) => {
        allGradientsTDH.push(wg);
      });
      consolidatedTdh.push(consolidation);
    }
    consolidations.forEach((c) => {
      processedWallets.add(c);
    });
  }

  return {
    consolidatedTdh: consolidatedTdh,
    allGradientsTDH: allGradientsTDH
  };
}

export const consolidateMissingWallets = async (
  wallets: string[]
): Promise<ConsolidatedTDH[]> => {
  const processedWallets = new Set<string>();
  const missingTdh: ConsolidatedTDH[] = [];
  const tdhBlock = await fetchLatestTDHBlockNumber();

  for (const wallet of wallets) {
    const consolidations = await retrieveWalletConsolidations(wallet);
    const display = await fetchConsolidationDisplay(consolidations);
    const consolidationKey = [...consolidations].sort().join('-');

    if (
      !Array.from(processedWallets).some((pw) => areEqualAddresses(wallet, pw))
    ) {
      processedWallets.add(wallet);
      missingTdh.push({
        date: new Date(),
        consolidation_display: display,
        consolidation_key: consolidationKey,
        wallets: consolidations,
        tdh_rank: 0,
        tdh_rank_memes: 0,
        tdh_rank_memes_szn1: 0,
        tdh_rank_memes_szn2: 0,
        tdh_rank_memes_szn3: 0,
        tdh_rank_memes_szn4: 0,
        tdh_rank_memes_szn5: 0,
        tdh_rank_memes_szn6: 0,
        tdh_rank_gradients: 0,
        block: tdhBlock,
        tdh: 0,
        boost: 0,
        boosted_tdh: 0,
        tdh__raw: 0,
        balance: 0,
        memes_cards_sets: 0,
        genesis: false,
        unique_memes: 0,
        unique_memes_season1: 0,
        unique_memes_season2: 0,
        unique_memes_season3: 0,
        unique_memes_season4: 0,
        unique_memes_season5: 0,
        unique_memes_season6: 0,
        boosted_memes_tdh: 0,
        memes_tdh: 0,
        memes_tdh__raw: 0,
        memes_balance: 0,
        boosted_memes_tdh_season1: 0,
        memes_tdh_season1: 0,
        memes_tdh_season1__raw: 0,
        memes_balance_season1: 0,
        boosted_memes_tdh_season2: 0,
        memes_tdh_season2: 0,
        memes_tdh_season2__raw: 0,
        memes_balance_season2: 0,
        boosted_memes_tdh_season3: 0,
        memes_tdh_season3: 0,
        memes_tdh_season3__raw: 0,
        memes_balance_season3: 0,
        boosted_memes_tdh_season4: 0,
        memes_tdh_season4: 0,
        memes_tdh_season4__raw: 0,
        memes_balance_season4: 0,
        boosted_memes_tdh_season5: 0,
        memes_tdh_season5: 0,
        memes_tdh_season5__raw: 0,
        memes_balance_season5: 0,
        boosted_memes_tdh_season6: 0,
        memes_tdh_season6: 0,
        memes_tdh_season6__raw: 0,
        memes_balance_season6: 0,
        memes: [],
        memes_ranks: [],
        boosted_gradients_tdh: 0,
        gradients_tdh: 0,
        gradients_tdh__raw: 0,
        gradients_balance: 0,
        gradients: [],
        gradients_ranks: []
      });
      consolidations.forEach((c) => {
        processedWallets.add(c);
      });
    }
  }

  return missingTdh;
};

export const consolidateTDH = async (
  lastTDHCalc: Date,
  startingWallets?: string[]
) => {
  const tdh: TDHENS[] = await fetchAllTDH(startingWallets);
  const nfts = await fetchAllNFTs();

  const ADJUSTED_NFTS = [...nfts].filter(
    (nft) =>
      lastTDHCalc.getTime() - 28 * 60 * 60 * 1000 >
      new Date(nft.mint_date).getTime()
  );

  const MEMES_COUNT = [...ADJUSTED_NFTS].filter((nft) =>
    areEqualAddresses(nft.contract, MEMES_CONTRACT)
  ).length;

  logger.info(`[WALLETS ${tdh.length}]`);

  const { consolidatedTdh, allGradientsTDH } = await consolidateTDHForWallets(
    tdh,
    MEMES_COUNT
  );

  const consolidatedBoostedTdh = await calculateBoosts(consolidatedTdh);

  if (startingWallets) {
    const missingWallets = startingWallets?.filter(
      (s) =>
        !consolidatedBoostedTdh.some((c) =>
          c.wallets.some((w: string) => areEqualAddresses(w, s))
        )
    );
    const missingConsolidatedTdh = await consolidateMissingWallets(
      missingWallets
    );
    logger.info(`[MISSING WALLETS TDH ${missingConsolidatedTdh.length}]`);
    consolidatedBoostedTdh.push(...missingConsolidatedTdh);
  }

  if (startingWallets) {
    await persistConsolidatedTDH(consolidatedBoostedTdh, startingWallets);
    logger.info(`[FINAL ENTRIES ${consolidatedBoostedTdh.length}]`);
  } else {
    const sortedConsolidatedTdh = await calculateRanks(
      allGradientsTDH,
      consolidatedBoostedTdh,
      ADJUSTED_NFTS,
      MEMES_COUNT
    );
    await persistConsolidatedTDH(sortedConsolidatedTdh);
    logger.info(`[FINAL ENTRIES ${sortedConsolidatedTdh.length}]`);
  }
};

function consolidateCards(consolidationTokens: any[], walletTokens: any[]) {
  const mergedArray = [...consolidationTokens, ...walletTokens].reduce(
    (accumulator, current) => {
      const existingIndex = accumulator.findIndex(
        (item: any) => item.id === current.id
      );

      if (existingIndex === -1) {
        accumulator.push(current);
      } else {
        accumulator[existingIndex].balance += current.balance;
        accumulator[existingIndex].tdh += current.tdh;
        accumulator[existingIndex].tdh__raw += current.tdh__raw;
      }

      return accumulator;
    },
    []
  );

  return mergedArray;
}

function getUniqueMemesSeason(season: number, consolidationTokens: any[]) {
  const unique = new Set();
  consolidationTokens.forEach((c) => {
    if (
      (season == 1 && c.id >= SZN1_INDEX.start && c.id <= SZN1_INDEX.end) ||
      (season == 2 && c.id >= SZN2_INDEX.start && c.id <= SZN2_INDEX.end) ||
      (season == 3 && c.id >= SZN3_INDEX.start && c.id <= SZN3_INDEX.end) ||
      (season == 4 && c.id >= SZN4_INDEX.start && c.id <= SZN4_INDEX.end) ||
      (season == 5 && c.id >= SZN5_INDEX.start && c.id <= SZN5_INDEX.end) ||
      (season == 6 && c.id >= SZN6_INDEX.start)
    ) {
      unique.add(c.id);
    }
  });
  return unique.size;
}
