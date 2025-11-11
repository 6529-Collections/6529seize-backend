import { consolidationTools } from '../consolidation-tools';
import {
  fetchAllConsolidatedTdh,
  fetchAllTDH,
  fetchConsolidationDisplay,
  fetchConsolidationDisplays,
  fetchLatestTDHBlockNumber,
  persistConsolidatedTDH,
  persistTDHBlock,
  retrieveConsolidationsForWallets,
  retrieveWalletConsolidations
} from '../db';
import { NextGenToken } from '../entities/INextGen';
import { MemesSeason } from '../entities/ISeason';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  TDHENS,
  TokenTDH
} from '../entities/ITDH';
import { Logger } from '../logging';
import { fetchNextgenTokens } from '../nextgen/nextgen.db';
import { equalIgnoreCase } from '../strings';
import {
  calculateBoosts,
  calculateRanks,
  createMemesData,
  getAdjustedMemesAndSeasons,
  getGenesisAndNaka
} from './tdh';
import { calculateTdhEditions } from './tdh_editions';
import { calculateMemesTdh } from './tdh_memes';
import { updateNftTDH } from './tdh_nft';

const logger = Logger.get('TDH_CONSOLIDATION');

export async function consolidateTDHForWallets(
  tdh: TDHENS[],
  MEMES_COUNT: number
) {
  const consolidatedTdh: ConsolidatedTDH[] = [];
  const processedWallets = new Set<string>();
  const allGradientsTDH: any[] = [];
  const allNextgenTDH: any[] = [];

  logger.info(`Starting to consolidate TDH for ${tdh.length} wallets`);
  const allWallets = tdh.map((t) => t.wallet.toLowerCase());
  const consolidationsForWallets =
    await retrieveConsolidationsForWallets(allWallets);
  const allConsolidationKeys = Object.values(consolidationsForWallets);
  const allConsolidationDisplays =
    await fetchConsolidationDisplays(allConsolidationKeys);
  const walletConsolidationInfos = Object.entries(
    consolidationsForWallets
  ).reduce(
    (acc, [wallet, consolidationKey]) => {
      const consolidationDisplay = allConsolidationDisplays[consolidationKey]!;
      acc[wallet] = {
        consolidationKey,
        consolidationDisplay
      };
      return acc;
    },
    {} as Record<
      string,
      { consolidationKey: string; consolidationDisplay: string }
    >
  );
  for (const tdhEntry of tdh) {
    const wallet = tdhEntry.wallet;
    const consolidationInfo = walletConsolidationInfos[wallet.toLowerCase()]!;
    const display = consolidationInfo.consolidationDisplay;
    const consolidationKey = consolidationInfo.consolidationKey;
    const consolidations = consolidationKey.split('-');

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

export const consolidateAndPersistTDH = async (
  block: number,
  blockTimestamp: Date,
  startingWallets?: string[]
): Promise<ConsolidatedTDH[]> => {
  const { adjustedSeasons, consolidatedTdh } = await consolidateTDH(
    block,
    blockTimestamp,
    startingWallets
  );
  const memesTdh = (await calculateMemesTdh(
    adjustedSeasons,
    consolidatedTdh,
    true
  )) as ConsolidatedTDHMemes[];

  const tdhEditions = await calculateTdhEditions(consolidatedTdh, true);

  await persistConsolidatedTDH(
    block,
    consolidatedTdh,
    memesTdh,
    tdhEditions,
    startingWallets
  );
  await updateNftTDH(consolidatedTdh, startingWallets);
  await persistTDHBlock(block, blockTimestamp, consolidatedTdh);

  return consolidatedTdh;
};

export const consolidateTDH = async (
  block: number,
  blockTimestamp: Date,
  startingWallets?: string[]
): Promise<{
  adjustedSeasons: MemesSeason[];
  consolidatedTdh: ConsolidatedTDH[];
}> => {
  const tdh: TDHENS[] = await fetchAllTDH(block, startingWallets);
  const NEXTGEN_NFTS: NextGenToken[] = await fetchNextgenTokens();

  const { ADJUSTED_NFTS, MEMES_COUNT, ADJUSTED_SEASONS } =
    await getAdjustedMemesAndSeasons(blockTimestamp);

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

  logger.info(`[FINAL ENTRIES ${rankedTdh.length}]`);
  return {
    adjustedSeasons: ADJUSTED_SEASONS,
    consolidatedTdh: rankedTdh
  };
};

export function consolidateCards(
  consolidationTokens: TokenTDH[],
  walletTokens: TokenTDH[]
): TokenTDH[] {
  const mergedArray = [...consolidationTokens, ...walletTokens].reduce<
    TokenTDH[]
  >((accumulator, current) => {
    const existingIndex = accumulator.findIndex(
      (item) => item.id === current.id
    );

    if (existingIndex === -1) {
      accumulator.push(current);
    } else {
      const existing = accumulator[existingIndex];
      existing.balance += current.balance;
      existing.tdh += current.tdh;
      existing.tdh__raw += current.tdh__raw;
      existing.days_held_per_edition = [
        ...existing.days_held_per_edition,
        ...current.days_held_per_edition
      ].sort((a, b) => a - b);
    }

    return accumulator;
  }, []);

  return mergedArray;
}
