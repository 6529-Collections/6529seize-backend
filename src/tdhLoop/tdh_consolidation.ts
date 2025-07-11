import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  TDHENS
} from '../entities/ITDH';
import {
  fetchAllConsolidatedTdh,
  fetchAllTDH,
  fetchConsolidationDisplay,
  fetchLatestTDHBlockNumber,
  persistConsolidatedTDH,
  persistTDHBlock,
  retrieveWalletConsolidations
} from '../db';
import {
  calculateBoosts,
  calculateRanks,
  createMemesData,
  getAdjustedMemesAndSeasons,
  getGenesisAndNaka
} from './tdh';
import { Logger } from '../logging';
import { NextGenToken } from '../entities/INextGen';
import { fetchNextgenTokens } from '../nextgen/nextgen.db';
import { calculateMemesTdh } from './tdh_memes';
import { updateNftTDH } from './tdh_nft';
import { equalIgnoreCase } from '../strings';
import { consolidationTools } from '../consolidation-tools';

const logger = Logger.get('TDH_CONSOLIDATION');

export async function consolidateTDHForWallets(
  tdh: TDHENS[],
  MEMES_COUNT: number
) {
  const consolidatedTdh: ConsolidatedTDH[] = [];
  const processedWallets = new Set<string>();
  const allGradientsTDH: any[] = [];
  const allNextgenTDH: any[] = [];

  for (const tdhEntry of tdh) {
    const wallet = tdhEntry.wallet;
    const consolidations = await retrieveWalletConsolidations(wallet);
    const display = await fetchConsolidationDisplay(consolidations);
    const consolidationKey =
      consolidationTools.buildConsolidationKey(consolidations);

    if (
      !Array.from(processedWallets).some((pw) => equalIgnoreCase(wallet, pw))
    ) {
      const consolidatedWalletsTdh = [...tdh].filter((t) =>
        consolidations.some((c) => equalIgnoreCase(c, t.wallet))
      );

      let totalTDH = 0;
      let totalTDH__raw = 0;
      let totalBalance = 0;

      const memesData = createMemesData();

      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;
      let gradientsBalance = 0;
      let nextgenTDH = 0;
      let nextgenTDH__raw = 0;
      let nextgenBalance = 0;
      let consolidationMemes: any[] = [];
      let consolidationGradients: any[] = [];
      let consolidationNextgen: any[] = [];

      consolidatedWalletsTdh.forEach((wTdh) => {
        totalTDH += wTdh.tdh;
        totalTDH__raw += wTdh.tdh__raw;
        totalBalance += wTdh.balance;
        memesData.memes_tdh += wTdh.memes_tdh;
        memesData.memes_tdh__raw += wTdh.memes_tdh__raw;
        memesData.memes_balance += wTdh.memes_balance;
        gradientsTDH += wTdh.gradients_tdh;
        gradientsTDH__raw += wTdh.gradients_tdh__raw;
        gradientsBalance += wTdh.gradients_balance;
        nextgenTDH += wTdh.nextgen_tdh;
        nextgenTDH__raw += wTdh.nextgen_tdh__raw;
        nextgenBalance += wTdh.nextgen_balance;
        consolidationMemes = consolidateCards(consolidationMemes, wTdh.memes);
        consolidationGradients = consolidateCards(
          consolidationGradients,
          wTdh.gradients
        );
        consolidationNextgen = consolidateCards(
          consolidationNextgen,
          wTdh.nextgen
        );
      });

      let memesCardSets = 0;
      if (consolidationMemes.length == MEMES_COUNT) {
        memesCardSets = Math.min(
          ...[...consolidationMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const unique_memes = consolidationMemes.length;

      const genNaka = getGenesisAndNaka(consolidationMemes);

      const consolidation: ConsolidatedTDH = {
        date: new Date(),
        consolidation_display: display,
        consolidation_key: consolidationKey,
        wallets: consolidations,
        tdh_rank: 0, //assigned later
        tdh_rank_memes: 0, //assigned later
        tdh_rank_gradients: 0, //assigned later
        tdh_rank_nextgen: 0, //assigned later
        block: tdhEntry.block,
        tdh: totalTDH,
        boost: 0,
        boosted_tdh: 0,
        tdh__raw: totalTDH__raw,
        balance: totalBalance,
        memes_cards_sets: memesCardSets,
        genesis: genNaka.genesis,
        nakamoto: genNaka.naka,
        unique_memes: unique_memes,
        memes_tdh: memesData.memes_tdh,
        memes_tdh__raw: memesData.memes_tdh__raw,
        memes_balance: memesData.memes_balance,
        boosted_memes_tdh: memesData.boosted_memes_tdh,
        memes_ranks: memesData.memes_ranks,
        memes: consolidationMemes,
        boosted_gradients_tdh: 0,
        gradients_tdh: gradientsTDH,
        gradients_tdh__raw: gradientsTDH__raw,
        gradients_balance: gradientsBalance,
        gradients: consolidationGradients,
        gradients_ranks: [],
        boosted_nextgen_tdh: 0,
        nextgen_tdh: nextgenTDH,
        nextgen_tdh__raw: nextgenTDH__raw,
        nextgen_balance: nextgenBalance,
        nextgen: consolidationNextgen,
        nextgen_ranks: [],
        boost_breakdown: {}
      };
      consolidationGradients.forEach((wg) => {
        allGradientsTDH.push(wg);
      });
      consolidationNextgen.forEach((wn) => {
        allNextgenTDH.push(wn);
      });
      consolidatedTdh.push(consolidation);
    }
    consolidations.forEach((c) => {
      processedWallets.add(c);
    });
  }

  return {
    consolidatedTdh: consolidatedTdh,
    allGradientsTDH: allGradientsTDH,
    allNextgenTDH: allNextgenTDH
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
    const consolidationKey =
      consolidationTools.buildConsolidationKey(consolidations);

    if (
      !Array.from(processedWallets).some((pw) => equalIgnoreCase(wallet, pw))
    ) {
      processedWallets.add(wallet);
      missingTdh.push({
        date: new Date(),
        consolidation_display: display,
        consolidation_key: consolidationKey,
        wallets: consolidations,
        tdh_rank: 0,
        tdh_rank_memes: 0,
        tdh_rank_gradients: 0,
        tdh_rank_nextgen: 0,
        block: tdhBlock,
        tdh: 0,
        boost: 0,
        boosted_tdh: 0,
        tdh__raw: 0,
        balance: 0,
        memes_cards_sets: 0,
        genesis: 0,
        nakamoto: 0,
        unique_memes: 0,
        boosted_memes_tdh: 0,
        memes_tdh: 0,
        memes_tdh__raw: 0,
        memes_balance: 0,
        memes: [],
        memes_ranks: [],
        boosted_gradients_tdh: 0,
        gradients_tdh: 0,
        gradients_tdh__raw: 0,
        gradients_balance: 0,
        gradients: [],
        gradients_ranks: [],
        boosted_nextgen_tdh: 0,
        nextgen_tdh: 0,
        nextgen_tdh__raw: 0,
        nextgen_balance: 0,
        nextgen: [],
        nextgen_ranks: [],
        boost_breakdown: {}
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
  block: number,
  timestamp: Date,
  startingWallets?: string[]
) => {
  const tdh: TDHENS[] = await fetchAllTDH(block, startingWallets);
  const NEXTGEN_NFTS: NextGenToken[] = await fetchNextgenTokens();

  const { ADJUSTED_NFTS, MEMES_COUNT, ADJUSTED_SEASONS } =
    await getAdjustedMemesAndSeasons(lastTDHCalc);

  logger.info(`[WALLETS ${tdh.length}]`);

  const { consolidatedTdh, allGradientsTDH, allNextgenTDH } =
    await consolidateTDHForWallets(tdh, MEMES_COUNT);

  const consolidatedBoostedTdh = await calculateBoosts(
    ADJUSTED_SEASONS,
    consolidatedTdh
  );

  if (startingWallets) {
    const missingWallets = startingWallets?.filter(
      (s) =>
        !consolidatedBoostedTdh.some((c) =>
          c.wallets.some((w: string) => equalIgnoreCase(w, s))
        )
    );
    const missingConsolidatedTdh =
      await consolidateMissingWallets(missingWallets);
    logger.info(`[MISSING WALLETS TDH ${missingConsolidatedTdh.length}]`);
    consolidatedBoostedTdh.push(...missingConsolidatedTdh);
  }

  let rankedTdh: ConsolidatedTDH[];
  if (startingWallets) {
    const allCurrentTdh = await fetchAllConsolidatedTdh();
    const allTdh = allCurrentTdh
      .filter(
        (t: ConsolidatedTDH) =>
          !startingWallets.some((sw) =>
            t.wallets.some((tw: string) => equalIgnoreCase(tw, sw))
          )
      )
      .concat(consolidatedBoostedTdh);
    const allRankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      allTdh,
      ADJUSTED_NFTS,
      NEXTGEN_NFTS
    );
    rankedTdh = allRankedTdh.filter((t: ConsolidatedTDH) =>
      startingWallets.some((sw) =>
        t.wallets.some((tw: string) => equalIgnoreCase(tw, sw))
      )
    );
  } else {
    rankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      consolidatedBoostedTdh,
      ADJUSTED_NFTS,
      NEXTGEN_NFTS
    );
  }

  const memesTdh = (await calculateMemesTdh(
    ADJUSTED_SEASONS,
    rankedTdh,
    true
  )) as ConsolidatedTDHMemes[];

  await persistConsolidatedTDH(rankedTdh, memesTdh, startingWallets);
  await updateNftTDH(rankedTdh, startingWallets);
  await persistTDHBlock(block, timestamp);
  logger.info(`[FINAL ENTRIES ${rankedTdh.length}]`);
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
