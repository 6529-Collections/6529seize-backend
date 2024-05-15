import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEME_8_BURN_TRANSACTION,
  NEXTGEN_CONTRACT,
  NULL_ADDRESS,
  WALLETS_TDH_TABLE
} from '../constants';
import { DefaultBoost, TDH, TokenTDH } from '../entities/ITDH';
import { Transaction } from '../entities/ITransaction';
import { areEqualAddresses, getDaysDiff } from '../helpers';
import { Alchemy } from 'alchemy-sdk';
import {
  consolidateTransactions,
  fetchAllConsolidationAddresses,
  fetchLatestTransactionsBlockNumber,
  fetchTDHForBlock,
  fetchWalletTransactions,
  persistOwners,
  persistTDH,
  persistTDHBlock,
  retrieveWalletConsolidations
} from '../db';
import { ConnectionWrapper, sqlExecutor } from '../sql-executor';
import { Logger } from '../logging';
import { NFT } from '../entities/INFT';
import { fetchNftOwners } from './nft_owners';
import { getAllNfts } from './nfts';
import { consolidateTDH } from './tdh_consolidation';
import { Time } from '../time';
import { processNftTdh } from './tdh_nfts';

const logger = Logger.get('TDH');

let alchemy: Alchemy;

export const TDH_CONTRACTS = [
  MEMES_CONTRACT,
  GRADIENT_CONTRACT,
  NEXTGEN_CONTRACT
];

export interface MemesSeason {
  id: number;
  start_index: number;
  end_index: number;
  count: number;
}

export function getDefaultBoost(): DefaultBoost {
  return {
    memes_card_sets: {
      available: 0.34,
      available_info: [
        '0.3 for Full Collection Set',
        '0.02 for each additional set up to 2'
      ],
      acquired: 0,
      acquired_info: []
    },
    memes_szn1: {
      available: 0.05,
      available_info: ['0.05 for Season 1 Set'],
      acquired: 0,
      acquired_info: []
    },
    memes_szn2: {
      available: 0.05,
      available_info: ['0.05 for Season 2 Set'],
      acquired: 0,
      acquired_info: []
    },
    memes_szn3: {
      available: 0.05,
      available_info: ['0.05 for Season 3 Set'],
      acquired: 0,
      acquired_info: []
    },
    memes_szn4: {
      available: 0.05,
      available_info: ['0.05 for Season 4 Set'],
      acquired: 0,
      acquired_info: []
    },
    memes_szn5: {
      available: 0.05,
      available_info: ['0.05 for Season 5 Set'],
      acquired: 0,
      acquired_info: []
    },
    memes_szn6: {
      available: 0.05,
      available_info: ['0.05 for Season 6 Set'],
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
      available: 0.06,
      available_info: ['0.02 for each Gradient up to 3'],
      acquired: 0,
      acquired_info: []
    }
  };
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

export const buildSeasons = (memes: NFT[]) => {
  const seasons: MemesSeason[] = [];
  let start = 0;
  let end = 0;
  let count = 0;
  let seasonId = 1;
  for (const meme of memes) {
    if (meme.season == seasonId) {
      count++;
      end = meme.id;
    } else {
      seasons.push({
        id: seasonId,
        start_index: start,
        end_index: end,
        count: count
      });
      seasonId++;
      start = meme.id;
      end = meme.id;
      count = 1;
    }
  }
  seasons.push({
    id: seasonId,
    start_index: start,
    end_index: end,
    count: count
  });
  return seasons;
};

export const updateTDH = async (
  lastTDHCalc: Date,
  startingWallets?: string[]
) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const block = await fetchLatestTransactionsBlockNumber(lastTDHCalc);

  if (!block) {
    logger.error('No transactions found, skipping TDH calculation');
    return;
  }

  const memeOwners = await fetchNftOwners(block, MEMES_CONTRACT);
  const gradientOwners = await fetchNftOwners(block, GRADIENT_CONTRACT);
  const nextgenOwners = await fetchNftOwners(block, NEXTGEN_CONTRACT);

  const {
    memes: initialMemes,
    gradients,
    nextgen
  } = await getAllNfts(memeOwners);
  const memes = initialMemes.filter(
    (m) =>
      m.mint_date &&
      Time.fromString(m.mint_date.toString()).lte(
        Time.fromDate(lastTDHCalc).minusDays(1)
      )
  );

  await persistOwners([...memeOwners, ...gradientOwners, ...nextgenOwners]);

  const HODL_INDEX = memes.reduce((acc, m) => Math.max(acc, m.edition_size), 0);
  const ADJUSTED_SEASONS = buildSeasons(memes);

  logger.info(
    `[MEMES] : [TOKENS ${memes.length}] : [OWNERS ${memeOwners.length}] : [SEASONS ${ADJUSTED_SEASONS.length}] : [HODL_INDEX ${HODL_INDEX}]`
  );
  logger.info(
    `[GRADIENTS] : [TOKENS ${gradients.length}] : [OWNERS ${gradientOwners.length}]`
  );
  logger.info(
    `[NEXTGEN] : [TOKENS ${nextgen.length}] : [OWNERS ${nextgenOwners.length}]`
  );

  const ADJUSTED_NFTS = [...memes, ...gradients, ...nextgen];

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

    const nftOwners = [...memeOwners, ...gradientOwners, ...nextgenOwners];
    nftOwners.forEach((w) => combinedAddresses.add(w.address.toLowerCase()));
  }

  logger.info(
    `[BLOCK ${block}] [WALLETS ${combinedAddresses.size}] [CALCULATING TDH - START]`
  );

  const timestamp = new Date(
    (await alchemy.core.getBlock(block)).timestamp * 1000
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
            TDH_CONTRACTS,
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

      if (areEqualAddresses(wallet, NULL_ADDRESS)) {
        consolidationTransactions = consolidationTransactions.filter(
          (t) => !areEqualAddresses(t.transaction, MEME_8_BURN_TRANSACTION)
        );
      }

      ADJUSTED_NFTS.forEach((nft) => {
        const tokenConsolidatedTransactions = [
          ...consolidationTransactions
        ].filter(
          (t) =>
            t.token_id == nft.id && areEqualAddresses(t.contract, nft.contract)
        );

        const hodlRate = HODL_INDEX / nft.edition_size;

        const tokenTDH = getTokenTdh(
          lastTDHCalc,
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

          if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
            memesData.memes_tdh += tokenTDH.tdh;
            memesData.memes_tdh__raw += tokenTDH.tdh__raw;
            unique_memes++;
            memesData.memes_balance += tokenTDH.balance;
            walletMemes.push(tokenTDH);
          } else if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
            gradientsTDH += tokenTDH.tdh;
            gradientsTDH__raw += tokenTDH.tdh__raw;
            gradientsBalance += tokenTDH.balance;
            walletGradients.push(tokenTDH);
          } else if (areEqualAddresses(nft.contract, NEXTGEN_CONTRACT)) {
            nextgenTDH += tokenTDH.tdh;
            nextgenTDH__raw += tokenTDH.tdh__raw;
            nextgenBalance += tokenTDH.balance;
            walletNextgen.push(tokenTDH);
          }
        }
      });

      let memesCardSets = 0;
      if (walletMemes.length == memes.length) {
        memesCardSets = Math.min(
          ...[...walletMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const genNaka = getGenesisAndNaka(walletMemes);

      const tdh: TDH = {
        date: new Date(),
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
        (t: TDH) =>
          !startingWallets.some((sw) => areEqualAddresses(sw, t.wallet))
      )
      .concat(boostedTdh);
    const allRankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      allTdh,
      ADJUSTED_NFTS
    );
    rankedTdh = allRankedTdh.filter((t: TDH) =>
      startingWallets.some((sw) => areEqualAddresses(sw, t.wallet))
    );
  } else {
    rankedTdh = await calculateRanks(
      allGradientsTDH,
      allNextgenTDH,
      boostedTdh,
      ADJUSTED_NFTS
    );
  }

  logger.info(
    `[BLOCK ${block}] [WALLETS ${rankedTdh.length}] [CALCULATING TDH - END]`
  );

  await persistTDH(block, rankedTdh, startingWallets);
  await persistTDHBlock(block, timestamp);
  await consolidateTDH(ADJUSTED_NFTS, startingWallets);
  await processNftTdh(ADJUSTED_NFTS);

  return {
    block: block,
    timestamp: timestamp,
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

function calculateMemesBoostsCardSets(cardSets: number) {
  let boost = 1;
  const breakdown = getDefaultBoost();

  let cardSetBreakdown = 0.3;
  const additionalCardSets = cardSets - 1;
  // additional full sets up to 2
  cardSetBreakdown += Math.min(additionalCardSets * 0.02, 0.04);
  boost += cardSetBreakdown;
  breakdown.memes_card_sets.acquired = cardSetBreakdown;

  const acquiredInfo = ['0.3 for Full Collection Set'];
  if (additionalCardSets === 1) {
    acquiredInfo.push(`0.02 for 1 additional set`);
  } else if (additionalCardSets > 1) {
    acquiredInfo.push(`0.04 for ${additionalCardSets} additional sets`);
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
  const breakdown = getDefaultBoost();

  const cardSetS1 = hasSeasonSet(1, seasons, memes);
  const cardSetS2 = hasSeasonSet(2, seasons, memes);
  const cardSetS3 = hasSeasonSet(3, seasons, memes);
  const cardSetS4 = hasSeasonSet(4, seasons, memes);
  const cardSetS5 = hasSeasonSet(5, seasons, memes);
  const cardSetS6 = hasSeasonSet(6, seasons, memes);

  if (cardSetS1) {
    boost += 0.05;
    breakdown.memes_szn1.acquired = 0.05;
    breakdown.memes_szn1.acquired_info = ['0.05 for holding Season 1 Set'];
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
  if (cardSetS2) {
    boost += 0.05;
    breakdown.memes_szn2.acquired = 0.05;
    breakdown.memes_szn2.acquired_info = ['0.05 for holding Season 2 Set'];
  }
  if (cardSetS3) {
    boost += 0.05;
    breakdown.memes_szn3.acquired = 0.05;
    breakdown.memes_szn3.acquired_info = ['0.05 for holding Season 3 Set'];
  }
  if (cardSetS4) {
    boost += 0.05;
    breakdown.memes_szn4.acquired = 0.05;
    breakdown.memes_szn4.acquired_info = ['0.05 for holding Season 4 Set'];
  }
  if (cardSetS5) {
    boost += 0.05;
    breakdown.memes_szn5.acquired = 0.05;
    breakdown.memes_szn5.acquired_info = ['0.05 for holding Season 5 Set'];
  }
  if (cardSetS6) {
    boost += 0.05;
    breakdown.memes_szn6.acquired = 0.05;
    breakdown.memes_szn6.acquired_info = ['0.05 for holding Season 6 Set'];
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
    return calculateMemesBoostsCardSets(cardSets);
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
  let { boost, breakdown } = calculateMemesBoosts(
    cardSets,
    seasons,
    s1Extra,
    memes
  );

  // GRADIENTS up to 3
  const gradientsBoost = Math.min(gradients.length * 0.02, 0.06);
  if (gradientsBoost > 0) {
    breakdown.gradients.acquired = gradientsBoost;
    breakdown.gradients.acquired_info = [
      `${gradientsBoost} for holding ${gradients.length} Gradient${
        gradients.length > 1 ? 's' : ''
      }`
    ];
    boost += gradientsBoost;
  }

  const total = Math.round(boost * 100) / 100;

  return {
    total: total,
    breakdown: breakdown
  };
}

function getTokenTdh(
  lastTDHCalc: Date,
  id: number,
  hodlRate: number,
  wallet: string,
  consolidations: string[],
  tokenConsolidatedTransactions: Transaction[]
) {
  const tokenDatesForWallet = getTokenDatesFromConsolidation(
    wallet,
    consolidations,
    tokenConsolidatedTransactions
  );

  let tdh__raw = 0;
  tokenDatesForWallet.forEach((e) => {
    const daysDiff = getDaysDiff(lastTDHCalc, e);
    if (daysDiff > 0) {
      tdh__raw += daysDiff;
    }
  });

  const balance = tokenDatesForWallet.length;
  const tdh = tdh__raw * hodlRate;

  if (tdh > 0 || balance > 0) {
    const tokenTDH = {
      id: id,
      balance: balance,
      tdh: tdh,
      tdh__raw: tdh__raw
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

  const sortedTransactions = consolidationTransactions
    .map((c) => {
      c.transaction_date = new Date(c.transaction_date);
      c.from_address = c.from_address.toLowerCase();
      c.to_address = c.to_address.toLowerCase();
      return c;
    })
    .sort(
      (a, b) => a.transaction_date.getTime() - b.transaction_date.getTime()
    );

  for (const transaction of sortedTransactions) {
    const { from_address, to_address, token_count, transaction_date } =
      transaction;

    const trDate = new Date(transaction_date);

    // inward
    if (consolidations.some((c) => areEqualAddresses(c, to_address))) {
      if (!consolidations.some((c) => areEqualAddresses(c, from_address))) {
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
    else if (consolidations.some((c) => areEqualAddresses(c, from_address))) {
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
      w.boost = boost;
      w.boosted_tdh = w.tdh * boost;
      w.boosted_memes_tdh = w.memes_tdh * boost;
      w.boosted_memes_tdh_season1 = w.memes_tdh_season1 * boost;
      w.boosted_memes_tdh_season2 = w.memes_tdh_season2 * boost;
      w.boosted_memes_tdh_season3 = w.memes_tdh_season3 * boost;
      w.boosted_memes_tdh_season4 = w.memes_tdh_season4 * boost;
      w.boosted_memes_tdh_season5 = w.memes_tdh_season5 * boost;
      w.boosted_memes_tdh_season6 = w.memes_tdh_season6 * boost;
      w.boosted_gradients_tdh = w.gradients_tdh * boost;
      w.boosted_nextgen_tdh = w.nextgen_tdh * boost;
      w.boost_breakdown = boostBreakdown.breakdown;
      boostedTDH.push(w);
    })
  );

  return boostedTDH;
}

export async function calculateRanks(
  allGradientsTDH: any[],
  allNextgenTDH: any[],
  boostedTDH: any[],
  ADJUSTED_NFTS: any[]
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
          (areEqualAddresses(nft.contract, MEMES_CONTRACT) &&
            w.memes.some((m: any) => m.id == nft.id)) ||
          (areEqualAddresses(nft.contract, GRADIENT_CONTRACT) &&
            w.gradients_tdh > 0)
      )
      .sort((a, b) => {
        const aNftBalance = areEqualAddresses(nft.contract, MEMES_CONTRACT)
          ? a.memes.find((m: any) => m.id == nft.id).tdh
          : a.gradients_tdh;
        const bNftBalance = areEqualAddresses(nft.contract, MEMES_CONTRACT)
          ? b.memes.find((m: any) => m.id == nft.id).tdh
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
        if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
          w.memes_ranks.push({
            id: nft.id,
            rank: index + 1
          });
          return w;
        }
        if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
          const gradient = w.gradients.find((g: any) => g.id == nft.id);
          if (gradient) {
            w.gradients_ranks.push({
              id: nft.id,
              rank: rankedGradientsTdh.find((s) => s.id == nft.id)?.rank
            });
          }
          return w;
        }
        if (areEqualAddresses(nft.contract, NEXTGEN_CONTRACT)) {
          const nextgen = w.nextgen.find((g: any) => g.id == nft.id);
          if (nextgen) {
            w.nextgen_ranks.push({
              id: nft.id,
              rank: rankedNextgenTdh.find((s) => s.id == nft.id)?.rank
            });
          }
          return w;
        }
      });

    if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
      const wallets = [...boostedTDH].filter((w) =>
        w.memes.some((m: any) => m.id == nft.id)
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
