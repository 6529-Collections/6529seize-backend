import { Alchemy } from 'alchemy-sdk';
import { ethers } from 'ethers';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEME_8_BURN_TRANSACTION,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import {
  consolidateTransactions,
  fetchAllConsolidationAddresses,
  fetchAllNFTs,
  fetchAllSeasons,
  fetchTDHForBlock,
  fetchWalletTransactions,
  persistTDH,
  retrieveWalletConsolidations
} from '../db';
import { NextGenToken } from '../entities/INextGen';
import { NFT } from '../entities/INFT';
import { MemesSeason } from '../entities/ISeason';
import { DefaultBoost, TDH, TDHMemes, TokenTDH } from '../entities/ITDH';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { fetchNextgenTokens } from '../nextgen/nextgen.db';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT
} from '../nextgen/nextgen_constants';
import { ConnectionWrapper, sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import { Time } from '../time';
import { calculateTdhEditions } from './tdh_editions';
import { calculateMemesTdh } from './tdh_memes';
import { extractMemesEditionSizes, extractNFTOwners } from './tdh_objects';

const logger = Logger.get('TDH');

let alchemy: Alchemy;

export function getDefaultBoost(seasons: MemesSeason[] = []): DefaultBoost {
  const boost: DefaultBoost = {
    memes_card_sets: {
      available: 0.744051,
      available_info: [
        '0.60 for Full Collection Set',
        '0.05 * 0.6529^(n-1) for each additional set (unlimited)'
      ],
      acquired: 0,
      acquired_info: []
    },
    memes_genesis: {
      available: 0.01,
      available_info: ['0.01 for Meme Cards #1, #2, #3 (Genesis Set)'],
      acquired: 0,
      acquired_info: []
    },
    memes_nakamoto: {
      available: 0.01,
      available_info: ['0.01 for Meme Card #4 (NakamotoFreedom)'],
      acquired: 0,
      acquired_info: []
    },
    gradients: {
      available: 0.1,
      available_info: ['0.02 for each Gradient up to 5'],
      acquired: 0,
      acquired_info: []
    }
  };

  const maxSeasonId =
    seasons.length > 0 ? Math.max(...seasons.map((s) => s.id)) : 0;
  const seasonsForBoost = seasons.filter(
    (s) => s.id < maxSeasonId && s.boost > 0
  );

  seasonsForBoost.forEach((season) => {
    boost[`memes_szn${season.id}` as keyof DefaultBoost] = {
      available: season.boost,
      available_info: [`${season.boost} for Season ${season.id} Set`],
      acquired: 0,
      acquired_info: []
    };
  });

  return boost;
}

export async function getWalletsTdhs(
  {
    wallets,
    blockNo
  }: {
    wallets: string[];
    blockNo: number;
  },
  connection?: ConnectionWrapper<any>
): Promise<Record<string, number>> {
  const normalisedWallets = wallets.map((w) => w.toLowerCase());
  if (!normalisedWallets.length) {
    return {};
  }
  const opts = connection ? { wrappedConnection: connection } : {};
  const result: { wallet: string; tdh: number }[] = await sqlExecutor.execute(
    `select wallet, boosted_tdh as tdh from ${WALLETS_TDH_TABLE} where block = :blockNo and lower(wallet) in (:wallets)`,
    {
      blockNo,
      wallets: normalisedWallets
    },
    opts
  );
  return normalisedWallets.reduce(
    (acc: Record<string, number>, wallet: string) => {
      acc[wallet.toLowerCase()] =
        result.find((r) => r.wallet.toLowerCase() === wallet.toLowerCase())
          ?.tdh ?? 0;
      return acc;
    },
    {}
  );
}

export function createMemesData() {
  return {
    memes_tdh: 0,
    memes_tdh__raw: 0,
    memes_balance: 0,
    boosted_memes_tdh: 0,
    memes_ranks: []
  };
}

export const getAdjustedMemesAndSeasons = async (timestamp: Date) => {
  const nfts: NFT[] = await fetchAllNFTs();
  const ADJUSTED_NFTS = [...nfts].filter(
    (nft) =>
      nft.mint_date &&
      Time.fromString(nft.mint_date.toString()).lte(
        Time.fromDate(timestamp).minusDays(1)
      )
  );

  const MEMES_COUNT = [...ADJUSTED_NFTS].filter((nft) =>
    equalIgnoreCase(nft.contract, MEMES_CONTRACT)
  ).length;

  const seasons = await fetchAllSeasons();
  const memeNfts = ADJUSTED_NFTS.filter((nft) =>
    equalIgnoreCase(nft.contract, MEMES_CONTRACT)
  );

  const ADJUSTED_SEASONS = seasons.filter(
    (s) => memeNfts.length >= s.start_index
  );

  return {
    ADJUSTED_NFTS,
    MEMES_COUNT,
    ADJUSTED_SEASONS
  };
};

export const updateTDH = async (
  lastTDHCalc: Date,
  startingWallets?: string[]
): Promise<{ block: number; blockTimestamp: Date; tdh: TDH[] }> => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const provider = new ethers.JsonRpcProvider(
    `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  );
  const beforeBlock = await findLatestBlockBeforeTimestamp(
    provider,
    lastTDHCalc.getTime() / 1000
  );
  const block = beforeBlock.number;

  const NEXTGEN_NFTS: NextGenToken[] = await fetchNextgenTokens();
  const nextgenNetwork = getNextgenNetwork();
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[nextgenNetwork];

  const tdhContracts = [MEMES_CONTRACT, GRADIENT_CONTRACT, NEXTGEN_CONTRACT];

  const transactions = await sqlExecutor.execute(
    `select * from ${TRANSACTIONS_TABLE} where block <= :block and contract in (:contracts)`,
    {
      block,
      contracts: tdhContracts
    }
  );

  logger.info(`[TRANSACTIONS COUNT ${transactions.length}]`);

  const owners = await extractNFTOwners(block, transactions);
  logger.info(`[OWNERS COUNT ${owners.length}]`);

  const memesEditionSizes = await extractMemesEditionSizes(transactions);
  const MEMES_HODL_INDEX = Object.values(memesEditionSizes).reduce(
    (acc, size) => Math.max(acc, size),
    0
  );
  logger.info(`[MEMES HODL INDEX ${MEMES_HODL_INDEX}]`);

  const combinedAddresses = new Set<string>();

  if (startingWallets) {
    startingWallets.forEach((w) => combinedAddresses.add(w));
    logger.info(`[STARTING UNIQUE WALLETS ${combinedAddresses.size}]`);
  } else {
    const consolidationAddresses: { wallet: string }[] =
      await fetchAllConsolidationAddresses();
    consolidationAddresses.forEach((w) =>
      combinedAddresses.add(w.wallet.toLowerCase())
    );

    owners.forEach((w) => combinedAddresses.add(w.wallet.toLowerCase()));
  }

  logger.info(`[UNIQUE WALLETS ${combinedAddresses.size}]`);

  const blockTimestamp = new Date(
    (await alchemy.core.getBlock(block)).timestamp * 1000
  );

  const { ADJUSTED_NFTS, MEMES_COUNT, ADJUSTED_SEASONS } =
    await getAdjustedMemesAndSeasons(blockTimestamp);

  logger.info(
    `[BLOCK ${block} - ${blockTimestamp.toUTCString()}] [ADJUSTED_NFTS ${
      ADJUSTED_NFTS.length
    }] : [ADJUSTED_MEMES_SEASONS ${ADJUSTED_SEASONS.length}] : [NEXTGEN_NFTS ${
      NEXTGEN_NFTS.length
    }] : [NEXTGEN NETWORK ${nextgenNetwork}] : [CALCULATING TDH - START]`
  );

  const walletsTDH: TDH[] = [];
  const allGradientsTDH: any[] = [];
  const allNextgenTDH: any[] = [];
  await Promise.all(
    Array.from(combinedAddresses).map(async (owner) => {
      const wallet = owner.toLowerCase();
      const consolidations = await retrieveWalletConsolidations(wallet);

      const walletMemes: any[] = [];
      let unique_memes = 0;
      const walletGradients: any[] = [];
      const walletNextgen: any[] = [];

      let totalTDH = 0;
      let totalTDH__raw = 0;
      let totalBalance = 0;
      const memesData = createMemesData();

      let gradientsBalance = 0;
      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;

      let nextgenBalance = 0;
      let nextgenTDH = 0;
      let nextgenTDH__raw = 0;

      let consolidationTransactions: Transaction[] = [];
      await Promise.all(
        consolidations.map(async (c) => {
          const transactions = await fetchWalletTransactions(
            tdhContracts,
            c,
            block
          );
          consolidationTransactions =
            consolidationTransactions.concat(transactions);
        })
      );

      consolidationTransactions = consolidateTransactions(
        consolidationTransactions
      ).sort((a, b) => {
        return (
          new Date(a.transaction_date).getTime() -
          new Date(b.transaction_date).getTime()
        );
      });

      consolidationTransactions = consolidationTransactions.filter(
        (t) => !equalIgnoreCase(t.from_address, t.to_address)
      );

      if (equalIgnoreCase(wallet, NULL_ADDRESS)) {
        logger.info(
          `[WALLET ${wallet}] [SKIPPING MEME CARD 8 BURN TRANSACTION ${MEME_8_BURN_TRANSACTION}]`
        );
        consolidationTransactions = consolidationTransactions.filter(
          (t) => !equalIgnoreCase(t.transaction, MEME_8_BURN_TRANSACTION)
        );
      }

      ADJUSTED_NFTS.forEach((nft) => {
        const tokenConsolidatedTransactions = [
          ...consolidationTransactions
        ].filter(
          (t) =>
            t.token_id == nft.id && equalIgnoreCase(t.contract, nft.contract)
        );

        const hodlRate = equalIgnoreCase(nft.contract, MEMES_CONTRACT)
          ? MEMES_HODL_INDEX / memesEditionSizes[nft.id]
          : nft.hodl_rate;

        if (tokenConsolidatedTransactions.length === 0) {
          return;
        }

        const tokenTDH = getTokenTdh(
          blockTimestamp,
          nft.id,
          hodlRate,
          wallet,
          consolidations,
          tokenConsolidatedTransactions
        );

        if (tokenTDH) {
          totalTDH += tokenTDH.tdh;
          totalTDH__raw += tokenTDH.tdh__raw;
          totalBalance += tokenTDH.balance;

          if (equalIgnoreCase(nft.contract, MEMES_CONTRACT)) {
            memesData.memes_tdh += tokenTDH.tdh;
            memesData.memes_tdh__raw += tokenTDH.tdh__raw;
            unique_memes++;
            memesData.memes_balance += tokenTDH.balance;
            walletMemes.push(tokenTDH);
          } else if (equalIgnoreCase(nft.contract, GRADIENT_CONTRACT)) {
            gradientsTDH += tokenTDH.tdh;
            gradientsTDH__raw += tokenTDH.tdh__raw;
            gradientsBalance += tokenTDH.balance;
            walletGradients.push(tokenTDH);
          }
        }
      });

      NEXTGEN_NFTS.forEach((nft: NextGenToken) => {
        const tokenConsolidatedTransactions = [
          ...consolidationTransactions
        ].filter(
          (t) =>
            t.token_id == nft.id &&
            equalIgnoreCase(t.contract, NEXTGEN_CONTRACT)
        );

        const tokenTDH = getTokenTdh(
          blockTimestamp,
          nft.id,
          nft.hodl_rate,
          wallet,
          consolidations,
          tokenConsolidatedTransactions
        );

        if (tokenTDH) {
          totalTDH += tokenTDH.tdh;
          totalTDH__raw += tokenTDH.tdh__raw;
          totalBalance += tokenTDH.balance;
          nextgenTDH += tokenTDH.tdh;
          nextgenTDH__raw += tokenTDH.tdh__raw;
          nextgenBalance += tokenTDH.balance;
          walletNextgen.push(tokenTDH);
        }
      });

      let memesCardSets = 0;
      if (walletMemes.length == MEMES_COUNT) {
        memesCardSets = Math.min(
          ...[...walletMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const genNaka = getGenesisAndNaka(walletMemes);

      if (totalTDH > 0 || totalBalance > 0 || consolidations.length > 1) {
        const tdh: TDH = {
          date: blockTimestamp,
          wallet: wallet,
          tdh_rank: 0, //assigned later
          tdh_rank_memes: 0, //assigned later
          tdh_rank_gradients: 0, //assigned later
          tdh_rank_nextgen: 0, //assigned later
          block: block,
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
          memes: walletMemes,
          boosted_gradients_tdh: 0,
          gradients_tdh: gradientsTDH,
          gradients_tdh__raw: gradientsTDH__raw,
          gradients_balance: gradientsBalance,
          gradients: walletGradients,
          gradients_ranks: [],
          boosted_nextgen_tdh: 0,
          nextgen_tdh: nextgenTDH,
          nextgen_tdh__raw: nextgenTDH__raw,
          nextgen_balance: nextgenBalance,
          nextgen: walletNextgen,
          nextgen_ranks: [],
          boost_breakdown: {}
        };
        walletGradients.forEach((wg) => {
          allGradientsTDH.push(wg);
        });
        walletNextgen.forEach((wn) => {
          allNextgenTDH.push(wn);
        });
        walletsTDH.push(tdh);
      }
    })
  );

  logger.info(
    `[BLOCK ${block}] [WALLETS ${walletsTDH.length}] [CALCULATING BOOSTS]`
  );

  const boostedTdh = await calculateBoosts(ADJUSTED_SEASONS, walletsTDH);

  let rankedTdh: TDH[];
  if (startingWallets) {
    const allCurrentTdh = await fetchTDHForBlock(block);
    const allTdh = allCurrentTdh
      .filter(
        (t: TDH) => !startingWallets.some((sw) => equalIgnoreCase(sw, t.wallet))
      )
      .concat(boostedTdh);
    const allRankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      allTdh,
      ADJUSTED_NFTS,
      NEXTGEN_NFTS
    );
    rankedTdh = allRankedTdh.filter((t: TDH) =>
      startingWallets.some((sw) => equalIgnoreCase(sw, t.wallet))
    );
  } else {
    rankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      boostedTdh,
      ADJUSTED_NFTS,
      NEXTGEN_NFTS
    );
  }

  logger.info(
    `[BLOCK ${block}] [WALLETS ${rankedTdh.length}] [CALCULATING TDH - END]`
  );

  const memesTdh = (await calculateMemesTdh(
    ADJUSTED_SEASONS,
    rankedTdh
  )) as TDHMemes[];

  const tdhEditions = await calculateTdhEditions(rankedTdh);
  await persistTDH(block, rankedTdh, memesTdh, tdhEditions, startingWallets);

  return {
    block: block,
    blockTimestamp,
    tdh: rankedTdh
  };
};

function hasSeasonSet(
  seasonId: number,
  seasons: MemesSeason[],
  memes: TokenTDH[]
): boolean {
  const season = seasons.find((s) => s.id == seasonId);
  if (!season) {
    return false;
  }
  const seasonMemes = memes.filter(
    (m) => m.id >= season.start_index && m.id <= season.end_index
  );

  return seasonMemes.length === season.count;
}

function calculateMemesBoostsCardSets(
  cardSets: number,
  seasons: MemesSeason[]
) {
  let boost = 1;
  const breakdown = getDefaultBoost(seasons);

  // Base for 1 full collection set in TDH 1.4
  let cardSetBreakdown = 0.6;

  const additionalCardSets = Math.max(0, cardSets - 1);
  if (additionalCardSets > 0) {
    // Geometric series: 0.05 * (1 - r^n) / (1 - r), with r = 0.6529
    const r = 0.6529;
    const increment = (0.05 * (1 - Math.pow(r, additionalCardSets))) / (1 - r);
    cardSetBreakdown += increment;
  }

  boost += cardSetBreakdown;
  breakdown.memes_card_sets.acquired = cardSetBreakdown;

  const acquiredInfo: string[] = ['0.60 for Full Collection Set'];
  if (additionalCardSets === 1) {
    acquiredInfo.push('0.05 for 1 additional set');
  } else if (additionalCardSets > 1) {
    // Keep numeric style; show total increment compactly
    const r = 0.6529;
    const increment = (0.05 * (1 - Math.pow(r, additionalCardSets))) / (1 - r);
    // Limit to 6 decimals
    const incStr = (Math.round(increment * 1e6) / 1e6).toString();
    acquiredInfo.push(
      `${incStr} total for ${additionalCardSets} additional sets (0.05 * (1 - 0.6529^${additionalCardSets}) / (1 - 0.6529))`
    );
  }
  breakdown.memes_card_sets.acquired_info = acquiredInfo;

  return {
    boost: boost,
    breakdown: breakdown
  };
}

function calculateMemesBoostsSeasons(
  seasons: MemesSeason[],
  s1Extra: {
    genesis: number;
    nakamoto: number;
  },
  memes: TokenTDH[]
) {
  let boost = 1;
  const maxSeasonId =
    seasons.length > 0 ? Math.max(...seasons.map((s) => s.id)) : 0;
  const seasonsForBoost = seasons.filter(
    (s) => s.id < maxSeasonId && s.boost > 0
  );
  const breakdown = getDefaultBoost(seasons);

  const applySeasonBoost = (seasonId: number) => {
    const seasonObj = seasons.find((s) => s.id === seasonId);
    if (!seasonObj) return;
    const seasonBoost = seasonObj.boost;
    boost += seasonBoost;
    (breakdown as any)[`memes_szn${seasonId}`].acquired = seasonBoost;
    (breakdown as any)[`memes_szn${seasonId}`].acquired_info = [
      `${seasonBoost} for holding Season ${seasonId} Set`
    ];
  };

  for (const season of seasonsForBoost) {
    const hasSet = hasSeasonSet(season.id, seasons, memes);

    if (season.id === 1) {
      if (hasSet) {
        applySeasonBoost(1);
      } else {
        if (s1Extra.genesis) {
          boost += 0.01;
          breakdown.memes_genesis.acquired = 0.01;
          breakdown.memes_genesis.acquired_info = [
            '0.01 for holding Meme Cards #1, #2, #3 (Genesis Set)'
          ];
        }
        if (s1Extra.nakamoto) {
          boost += 0.01;
          breakdown.memes_nakamoto.acquired = 0.01;
          breakdown.memes_nakamoto.acquired_info = [
            '0.01 for holding Meme Cards #4 (NakamotoFreedom)'
          ];
        }
      }
    } else if (hasSet) {
      applySeasonBoost(season.id);
    }
  }

  return {
    boost: boost,
    breakdown: breakdown
  };
}

function calculateMemesBoosts(
  cardSets: number,
  seasons: MemesSeason[],
  s1Extra: {
    genesis: number;
    nakamoto: number;
  },
  memes: TokenTDH[]
) {
  if (cardSets > 0) {
    /* Category A */
    return calculateMemesBoostsCardSets(cardSets, seasons);
  } else {
    /* Category B */
    return calculateMemesBoostsSeasons(seasons, s1Extra, memes);
  }
}

export function calculateBoost(
  seasons: MemesSeason[],
  cardSets: number,
  s1Extra: {
    genesis: number;
    nakamoto: number;
  },
  memes: TokenTDH[],
  gradients: any[]
) {
  const memesBoosts = calculateMemesBoosts(cardSets, seasons, s1Extra, memes);

  let boost = memesBoosts.boost;
  const breakdown = memesBoosts.breakdown;

  // GRADIENTS up to 5
  const countedGradients = Math.min(gradients.length, 5);
  const gradientsBoost = Math.min(gradients.length * 0.02, 0.1);
  if (gradientsBoost > 0) {
    breakdown.gradients.acquired = gradientsBoost;
    breakdown.gradients.acquired_info = [
      `${gradientsBoost} for holding ${countedGradients} Gradient${countedGradients > 1 ? 's' : ''}`
    ];
    boost += gradientsBoost;
  }

  const total = Math.round(boost * 100) / 100;

  return {
    total: total,
    breakdown: breakdown
  };
}

function getFullDaysBetweenDates(t1: Date, t2: Date) {
  const diff = t1.getTime() - t2.getTime();
  return Math.floor(diff / (1000 * 3600 * 24));
}

function getTokenTdh(
  timestamp: Date,
  id: number,
  hodlRate: number,
  wallet: string,
  consolidations: string[],
  tokenConsolidatedTransactions: Transaction[]
): TokenTDH | null {
  const tokenDatesForWallet = getTokenDatesFromConsolidation(
    wallet,
    consolidations,
    tokenConsolidatedTransactions
  );

  let tdh__raw = 0;
  const daysHeldPerEdition: number[] = [];
  tokenDatesForWallet.forEach((e) => {
    const daysDiff = getFullDaysBetweenDates(timestamp, e);
    if (daysDiff > 0) {
      tdh__raw += daysDiff;
      daysHeldPerEdition.push(daysDiff);
    }
  });

  const balance = tokenDatesForWallet.length;

  hodlRate = Math.round(hodlRate * 100) / 100;
  const tdh = Math.round(hodlRate * tdh__raw * 1000) / 1000;

  if (tdh > 0 || balance > 0) {
    const tokenTDH: TokenTDH = {
      id: id,
      balance: balance,
      hodl_rate: hodlRate,
      tdh: Math.round(tdh),
      tdh__raw: tdh__raw,
      days_held_per_edition: daysHeldPerEdition
    };
    return tokenTDH;
  }
  return null;
}

function getTokenDatesFromConsolidation(
  currentWallet: string,
  consolidations: string[],
  consolidationTransactions: Transaction[]
) {
  const tokenDatesMap: { [wallet: string]: Date[] } = {};

  function addDates(wallet: string, dates: Date[]) {
    if (!tokenDatesMap[wallet]) {
      tokenDatesMap[wallet] = [];
    }

    tokenDatesMap[wallet].push(...dates);
  }

  function removeDates(wallet: string, count: number) {
    const removeDates = tokenDatesMap[wallet].splice(
      tokenDatesMap[wallet].length - count,
      count
    );
    return removeDates;
  }

  consolidationTransactions = consolidationTransactions
    .map((c) => {
      c.transaction_date = Time.fromUtcDateString(
        c.transaction_date.toString()
      ).toDate();
      c.from_address = c.from_address.toLowerCase();
      c.to_address = c.to_address.toLowerCase();
      return c;
    })
    .sort((a, b) => {
      const dateComparison =
        a.transaction_date.getTime() - b.transaction_date.getTime();

      if (dateComparison !== 0) {
        return dateComparison;
      }

      const aInConsolidations = Number(
        consolidations.some(
          (c) =>
            !equalIgnoreCase(c, currentWallet) &&
            equalIgnoreCase(c, a.from_address)
        )
      );

      const bInConsolidations = Number(
        consolidations.some(
          (c) =>
            !equalIgnoreCase(c, currentWallet) &&
            equalIgnoreCase(c, b.from_address)
        )
      );

      if (aInConsolidations || bInConsolidations) {
        return bInConsolidations - aInConsolidations;
      }

      if (equalIgnoreCase(a.to_address, currentWallet)) {
        return -1;
      }
      if (equalIgnoreCase(b.to_address, currentWallet)) {
        return 1;
      }

      return 0;
    });

  for (const transaction of consolidationTransactions) {
    const { from_address, to_address, token_count, transaction_date } =
      transaction;

    const trDate = new Date(transaction_date);

    // inward
    if (consolidations.some((c) => equalIgnoreCase(c, to_address))) {
      if (!consolidations.some((c) => equalIgnoreCase(c, from_address))) {
        addDates(
          to_address,
          Array.from({ length: token_count }, () => trDate)
        );
      } else {
        const removedDates = removeDates(from_address, token_count);
        addDates(to_address, removedDates);
      }
    }

    // outward
    else if (consolidations.some((c) => equalIgnoreCase(c, from_address))) {
      removeDates(from_address, token_count);
    }
  }

  return tokenDatesMap[currentWallet] || [];
}

export async function calculateBoosts(
  seasons: MemesSeason[],
  walletsTDH: any[]
) {
  const boostedTDH: any[] = [];

  await Promise.all(
    walletsTDH.map(async (w) => {
      const boostBreakdown = calculateBoost(
        seasons,
        w.memes_cards_sets,
        {
          genesis: w.genesis,
          nakamoto: w.nakamoto
        },
        w.memes,
        w.gradients
      );

      const boost = boostBreakdown.total;

      const boostedMemesTdh = w.memes.reduce(
        (sum: number, m: TokenTDH) => sum + Math.round(m.tdh * boost),
        0
      );

      const boostedGradientsTdh = w.gradients.reduce(
        (sum: number, g: any) => sum + Math.round(g.tdh * boost),
        0
      );

      const boostedNextgenTdh = w.nextgen.reduce(
        (sum: number, n: any) => sum + Math.round(n.tdh * boost),
        0
      );

      const boostedTdh =
        Math.round(boostedMemesTdh) +
        Math.round(boostedGradientsTdh) +
        Math.round(boostedNextgenTdh);

      w.boost = boost;
      w.boost_breakdown = boostBreakdown.breakdown;
      w.boosted_tdh = boostedTdh;
      w.boosted_memes_tdh = boostedMemesTdh;
      w.boosted_gradients_tdh = boostedGradientsTdh;
      w.boosted_nextgen_tdh = boostedNextgenTdh;

      boostedTDH.push(w);
    })
  );

  return boostedTDH;
}

export async function calculateRanks(
  allGradientsTDH: any[],
  allNextgenTDH: any[],
  boostedTDH: any[],
  ADJUSTED_NFTS: any[],
  NEXTGEN_NFTS: NextGenToken[]
) {
  allGradientsTDH.sort((a, b) => b.tdh - a.tdh || a.id - b.id || -1);
  const rankedGradientsTdh = allGradientsTDH.map((a, index) => {
    a.rank = index + 1;
    return a;
  });

  allNextgenTDH.sort((a, b) => b.tdh - a.tdh || a.id - b.id || -1);
  const rankedNextgenTdh = allNextgenTDH.map((a, index) => {
    a.rank = index + 1;
    return a;
  });

  ADJUSTED_NFTS.forEach((nft) => {
    boostedTDH
      .filter(
        (w) =>
          (equalIgnoreCase(nft.contract, MEMES_CONTRACT) &&
            w.memes?.some((m: any) => m.id == nft.id)) ||
          (equalIgnoreCase(nft.contract, GRADIENT_CONTRACT) &&
            w.gradients_tdh > 0)
      )
      .sort((a, b) => {
        const aNftBalance = equalIgnoreCase(nft.contract, MEMES_CONTRACT)
          ? a.memes?.find((m: any) => m.id == nft.id).tdh
          : a.gradients_tdh;
        const bNftBalance = equalIgnoreCase(nft.contract, MEMES_CONTRACT)
          ? b.memes?.find((m: any) => m.id == nft.id).tdh
          : b.gradients_tdh;

        if (aNftBalance > bNftBalance) {
          return -1;
        } else if (aNftBalance < bNftBalance) {
          return 1;
        } else {
          if (a.boosted_tdh > b.boosted_tdh) {
            return -1;
          }
          return 1;
        }
      })
      .forEach((w, index) => {
        if (equalIgnoreCase(nft.contract, MEMES_CONTRACT)) {
          w.memes_ranks.push({
            id: nft.id,
            rank: index + 1
          });
          return w;
        }
        if (equalIgnoreCase(nft.contract, GRADIENT_CONTRACT)) {
          const gradient = w.gradients.find((g: any) => g.id == nft.id);
          if (gradient) {
            w.gradients_ranks.push({
              id: nft.id,
              rank: rankedGradientsTdh.find((s) => s.id == nft.id)?.rank
            });
          }
          return w;
        }
      });

    if (equalIgnoreCase(nft.contract, MEMES_CONTRACT)) {
      const wallets = [...boostedTDH].filter((w) =>
        w.memes?.some((m: any) => m.id == nft.id)
      );

      wallets.sort((a, b) => {
        const aNftBalance = a.memes.find((m: any) => m.id == nft.id).tdh;
        const bNftBalance = b.memes.find((m: any) => m.id == nft.id).tdh;

        if (aNftBalance > bNftBalance) {
          return -1;
        }
        if (aNftBalance > bNftBalance) {
          return -1;
        } else if (aNftBalance < bNftBalance) {
          return 1;
        } else {
          if (a.boosted_tdh > b.boosted_tdh) {
            return -1;
          }
          return 1;
        }
      });
    }
  });

  NEXTGEN_NFTS.forEach((nft) => {
    boostedTDH
      .filter((w) => w.nextgen?.some((n: any) => n.id == nft.id && n.tdh > 0))
      .forEach((w) => {
        const nextgen = w.nextgen?.find((g: any) => g.id == nft.id);
        if (nextgen) {
          w.nextgen_ranks.push({
            id: nft.id,
            rank: rankedNextgenTdh.find((s) => s.id == nft.id)?.rank
          });
        }
        return w;
      });
  });

  boostedTDH.sort((a: TDH, b: TDH) => {
    if (a.boosted_tdh > b.boosted_tdh) return -1;
    else if (a.boosted_tdh < b.boosted_tdh) return 1;
    else if (a.tdh > b.tdh) return -1;
    else if (a.tdh < b.tdh) return 1;
    else if (a.gradients_tdh > b.gradients_tdh) return -1;
    else if (a.gradients_tdh < b.gradients_tdh) return 1;
    else if (a.nextgen_tdh > b.nextgen_tdh) return -1;
    else if (a.nextgen_tdh < b.nextgen_tdh) return 1;
    else return -1;
  });
  boostedTDH = boostedTDH.map((w, index) => {
    w.tdh_rank = index + 1;
    return w;
  });

  boostedTDH.sort((a: TDH, b: TDH) => {
    if (a.boosted_memes_tdh > b.boosted_memes_tdh) return -1;
    else if (a.boosted_memes_tdh < b.boosted_memes_tdh) return 1;
    else if (a.memes_tdh > b.memes_tdh) return -1;
    else if (a.memes_tdh < b.memes_tdh) return 1;
    else if (a.memes_balance > b.memes_balance) return -1;
    else if (a.memes_balance < b.memes_balance) return 1;
    else if (a.balance > b.balance) return -1;
    else return -1;
  });
  boostedTDH = boostedTDH.map((w, index) => {
    if (w.boosted_memes_tdh > 0) {
      w.tdh_rank_memes = index + 1;
    } else {
      w.tdh_rank_memes = -1;
    }
    return w;
  });

  boostedTDH.sort((a: TDH, b: TDH) => {
    if (a.boosted_gradients_tdh > b.boosted_gradients_tdh) return -1;
    else if (a.boosted_gradients_tdh < b.boosted_gradients_tdh) return 1;
    else if (a.gradients_tdh > b.gradients_tdh) return -1;
    else if (a.gradients_tdh < b.gradients_tdh) return 1;
    else if (a.gradients_balance > b.gradients_balance) return -1;
    else if (a.gradients_balance < b.gradients_balance) return 1;
    else if (a.balance > b.balance) return -1;
    else return -1;
  });
  boostedTDH = boostedTDH.map((w, index) => {
    if (w.boosted_gradients_tdh > 0) {
      w.tdh_rank_gradients = index + 1;
    } else {
      w.tdh_rank_gradients = -1;
    }
    return w;
  });

  boostedTDH.sort((a: TDH, b: TDH) => {
    if (a.boosted_nextgen_tdh > b.boosted_nextgen_tdh) return -1;
    else if (a.boosted_nextgen_tdh < b.boosted_nextgen_tdh) return 1;
    else if (a.nextgen_tdh > b.nextgen_tdh) return -1;
    else if (a.nextgen_tdh < b.nextgen_tdh) return 1;
    else if (a.nextgen_balance > b.nextgen_balance) return -1;
    else if (a.nextgen_balance < b.nextgen_balance) return 1;
    else if (a.balance > b.balance) return -1;
    else return -1;
  });
  boostedTDH = boostedTDH.map((w, index) => {
    if (w.boosted_nextgen_tdh > 0) {
      w.tdh_rank_nextgen = index + 1;
    } else {
      w.tdh_rank_nextgen = -1;
    }
    return w;
  });

  return boostedTDH;
}

export function getGenesisAndNaka(memes: TokenTDH[]) {
  const gen1 = memes.find((a) => a.id == 1 && a.balance > 0)?.balance ?? 0;
  const gen2 = memes.find((a) => a.id == 2 && a.balance > 0)?.balance ?? 0;
  const gen3 = memes.find((a) => a.id == 3 && a.balance > 0)?.balance ?? 0;
  const naka = memes.find((a) => a.id == 4 && a.balance > 0)?.balance ?? 0;
  const genesis = Math.min(gen1, gen2, gen3);

  return {
    genesis,
    naka
  };
}

export async function findLatestBlockBeforeTimestamp(
  provider: ethers.JsonRpcProvider,
  targetTimestamp: number
) {
  logger.info(`FINDING LATEST BLOCK BEFORE TIMESTAMP [${targetTimestamp}]`);
  const averageBlockTime = 12; // Approximate average block time in seconds
  const latestBlock = await provider.getBlock('latest');
  if (!latestBlock) {
    throw new Error('Latest block not found');
  }

  let startBlock = Math.max(
    0,
    latestBlock.number -
      Math.floor((latestBlock.timestamp - targetTimestamp) / averageBlockTime)
  );
  let endBlock = latestBlock.number;

  // Perform a binary search
  while (startBlock <= endBlock) {
    const midBlockNumber = Math.floor((startBlock + endBlock) / 2);
    const midBlock = await provider.getBlock(midBlockNumber);
    if (!midBlock) {
      throw new Error('Mid block not found');
    }
    if (midBlock.timestamp === targetTimestamp) {
      // Exact match
      return midBlock;
    } else if (midBlock.timestamp < targetTimestamp) {
      // Move search to more recent blocks
      startBlock = midBlockNumber + 1;
    } else {
      // Move search to older blocks
      endBlock = midBlockNumber - 1;
    }
  }

  // `endBlock` is the latest block with a timestamp before the target
  const blockBefore = await provider.getBlock(endBlock);
  if (!blockBefore) {
    throw new Error('Block before not found');
  }
  return blockBefore;
}
