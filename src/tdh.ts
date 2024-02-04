import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  SZN1_INDEX,
  SZN2_INDEX,
  SZN3_INDEX,
  SZN4_INDEX,
  SZN5_INDEX,
  WALLETS_TDH_TABLE
} from './constants';
import { TDH } from './entities/ITDH';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses, getDaysDiff } from './helpers';
import { Alchemy } from 'alchemy-sdk';
import {
  fetchLatestTransactionsBlockNumber,
  fetchAllNFTs,
  fetchAllOwnersAddresses,
  fetchWalletTransactions,
  persistTDH,
  retrieveWalletConsolidations,
  consolidateTransactions,
  fetchHasEns,
  fetchAllProfiles,
  fetchAllConsolidationAddresses
} from './db';
import { sqlExecutor } from './sql-executor';
import { Logger } from './logging';
import { fetchNextgenTokens } from './nextgen/nextgen.db';
import { NextGenToken } from './entities/INextGen';
import { NFT } from './entities/INFT';
import {
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from './nextgen/nextgen_constants';

const logger = Logger.get('TDH');

let alchemy: Alchemy;

export async function getWalletsTdhs({
  wallets,
  blockNo
}: {
  wallets: string[];
  blockNo: number;
}): Promise<Record<string, number>> {
  const normalisedWallets = wallets.map((w) => w.toLowerCase());
  if (!normalisedWallets.length) {
    return {};
  }
  const result: { wallet: string; tdh: number }[] = await sqlExecutor.execute(
    `select wallet, boosted_tdh as tdh from ${WALLETS_TDH_TABLE} where block = :blockNo and lower(wallet) in (:wallets)`,
    {
      blockNo,
      wallets: normalisedWallets
    }
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
    memes_tdh_season1: 0,
    memes_tdh_season1__raw: 0,
    memes_balance_season1: 0,
    memes_tdh_season2: 0,
    memes_tdh_season2__raw: 0,
    memes_balance_season2: 0,
    memes_tdh_season3: 0,
    memes_tdh_season3__raw: 0,
    memes_balance_season3: 0,
    memes_tdh_season4: 0,
    memes_tdh_season4__raw: 0,
    memes_balance_season4: 0,
    memes_tdh_season5: 0,
    memes_tdh_season5__raw: 0,
    memes_balance_season5: 0,
    memes_tdh_season6: 0,
    memes_tdh_season6__raw: 0,
    memes_balance_season6: 0,
    boosted_memes_tdh: 0,
    boosted_memes_tdh_season1: 0,
    boosted_memes_tdh_season2: 0,
    boosted_memes_tdh_season3: 0,
    boosted_memes_tdh_season4: 0,
    boosted_memes_tdh_season5: 0,
    boosted_memes_tdh_season6: 0,
    memes_ranks: []
  };
}

export const findTDH = async (lastTDHCalc: Date) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const block = await fetchLatestTransactionsBlockNumber(lastTDHCalc);
  const nfts: NFT[] = await fetchAllNFTs();
  const owners: { wallet: string }[] = await fetchAllOwnersAddresses();
  const consolidationAddresses = await fetchAllConsolidationAddresses();

  const NEXTGEN_NFTS: NextGenToken[] = await fetchNextgenTokens();
  const nextgenNetwork = getNextgenNetwork();
  const NEXTGEN_CONTRACT = NEXTGEN_CORE_CONTRACT[nextgenNetwork];

  const combinedAddresses = owners
    .concat(consolidationAddresses)
    .concat(NEXTGEN_NFTS.map((nft) => ({ wallet: nft.owner })))
    .filter(
      (value, index, self) =>
        self.findIndex((item) =>
          areEqualAddresses(item.wallet, value.wallet)
        ) === index
    );

  const ADJUSTED_NFTS = [...nfts].filter(
    (nft) =>
      lastTDHCalc.getTime() - 28 * 60 * 60 * 1000 >
      new Date(nft.mint_date).getTime()
  );

  const MEMES_COUNT = [...ADJUSTED_NFTS].filter((nft) =>
    areEqualAddresses(nft.contract, MEMES_CONTRACT)
  ).length;

  const walletsTDH: TDH[] = [];

  const timestamp = new Date(
    (await alchemy.core.getBlock(block)).timestamp * 1000
  );

  logger.info(
    `[BLOCK ${block} - ${timestamp.toUTCString()}] [LAST TDH ${lastTDHCalc.toUTCString()}] [ADJUSTED_NFTS ${
      ADJUSTED_NFTS.length
    }] : [NEXTGEN_NFTS ${
      NEXTGEN_NFTS.length
    }] : [NEXTGEN NETWORK ${nextgenNetwork}] : [CALCULATING TDH - START]`
  );

  logger.info(
    `[OWNER UNIQUE WALLETS ${owners.length}] : [CONSOLIDATIONS UNIQUE WALLETS ${consolidationAddresses.length}] : [COMBINED UNIQUE WALLETS ${combinedAddresses.length}]`
  );

  const allGradientsTDH: any[] = [];
  const allNextgenTDH: any[] = [];
  await Promise.all(
    combinedAddresses.map(async (owner) => {
      const wallet = owner.wallet.toLowerCase();
      const consolidations = await retrieveWalletConsolidations(wallet);

      const walletMemes: any[] = [];
      let unique_memes = 0;
      let unique_memes_season1 = 0;
      let unique_memes_season2 = 0;
      let unique_memes_season3 = 0;
      let unique_memes_season4 = 0;
      let unique_memes_season5 = 0;
      let unique_memes_season6 = 0;
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

      const walletTransactionsNfts = await fetchWalletTransactions(
        wallet,
        false,
        block
      );

      const walletTransactionsNextgen = await fetchWalletTransactions(
        wallet,
        true,
        block
      );

      const walletTransactions: Transaction[] = consolidateTransactions([
        ...walletTransactionsNfts,
        ...walletTransactionsNextgen
      ]).sort((a: Transaction, b: Transaction) => {
        return (
          new Date(a.transaction_date).getTime() -
          new Date(b.transaction_date).getTime()
        );
      });

      let consolidationTransactions: Transaction[] = walletTransactions;
      await Promise.all(
        consolidations.map(async (c) => {
          if (!areEqualAddresses(c, wallet)) {
            const nftTrx = await fetchWalletTransactions(c, false, block);
            const nextgenTrx = await fetchWalletTransactions(c, true, block);
            consolidationTransactions = consolidationTransactions
              .concat(nftTrx)
              .concat(nextgenTrx);
          }
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

      ADJUSTED_NFTS.forEach((nft) => {
        const tokenConsolidatedTransactions = [
          ...consolidationTransactions
        ].filter(
          (t) =>
            t.token_id == nft.id && areEqualAddresses(t.contract, nft.contract)
        );

        const tokenTDH = getTokenTdh(
          lastTDHCalc,
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

          if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
            memesData.memes_tdh += tokenTDH.tdh;
            memesData.memes_tdh__raw += tokenTDH.tdh__raw;
            const season = parseInt(
              nft.metadata.attributes.find(
                (a: any) => a.trait_type === 'Type - Season'
              )?.value
            );
            if (season == 1) {
              memesData.memes_tdh_season1 += tokenTDH.tdh;
              memesData.memes_tdh_season1__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season1 += tokenTDH.balance;
              unique_memes_season1++;
            }
            if (season == 2) {
              memesData.memes_tdh_season2 += tokenTDH.tdh;
              memesData.memes_tdh_season2__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season2 += tokenTDH.balance;
              unique_memes_season2++;
            }
            if (season == 3) {
              memesData.memes_tdh_season3 += tokenTDH.tdh;
              memesData.memes_tdh_season3__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season3 += tokenTDH.balance;
              unique_memes_season3++;
            }
            if (season == 4) {
              memesData.memes_tdh_season4 += tokenTDH.tdh;
              memesData.memes_tdh_season4__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season4 += tokenTDH.balance;
              unique_memes_season4++;
            }
            if (season == 5) {
              memesData.memes_tdh_season5 += tokenTDH.tdh;
              memesData.memes_tdh_season5__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season5 += tokenTDH.balance;
              unique_memes_season5++;
            }
            if (season == 6) {
              memesData.memes_tdh_season6 += tokenTDH.tdh;
              memesData.memes_tdh_season6__raw += tokenTDH.tdh__raw;
              memesData.memes_balance_season6 += tokenTDH.balance;
              unique_memes_season6++;
            }
            unique_memes++;
            memesData.memes_balance += tokenTDH.balance;
            walletMemes.push(tokenTDH);
          } else if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
            gradientsTDH += tokenTDH.tdh;
            gradientsTDH__raw += tokenTDH.tdh__raw;
            gradientsBalance += tokenTDH.balance;
            walletGradients.push(tokenTDH);
          }
        }
      });

      NEXTGEN_NFTS.forEach((nft: NextGenToken) => {
        if (areEqualAddresses(wallet, nft.owner)) {
          const tokenConsolidatedTransactions = [
            ...consolidationTransactions
          ].filter(
            (t) =>
              t.token_id == nft.id &&
              areEqualAddresses(t.contract, NEXTGEN_CONTRACT)
          );

          const tokenTDH = getTokenTdh(
            lastTDHCalc,
            nft.id,
            nft.hodl_rate,
            wallet,
            consolidations,
            tokenConsolidatedTransactions,
            true
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
        }
      });

      let memesCardSets = 0;
      if (walletMemes.length == MEMES_COUNT) {
        memesCardSets = Math.min.apply(
          Math,
          [...walletMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const gen1 = walletMemes.some((a) => a.id == 1 && a.balance > 0);
      const gen2 = walletMemes.some((a) => a.id == 2 && a.balance > 0);
      const gen3 = walletMemes.some((a) => a.id == 3 && a.balance > 0);
      const genesis = gen1 && gen2 && gen3;

      if (totalTDH > 0 || totalBalance > 0 || consolidations.length > 1) {
        const tdh: TDH = {
          date: new Date(),
          wallet: wallet,
          tdh_rank: 0, //assigned later
          tdh_rank_memes: 0, //assigned later
          tdh_rank_memes_szn1: 0, //assigned later
          tdh_rank_memes_szn2: 0, //assigned later
          tdh_rank_memes_szn3: 0, //assigned later
          tdh_rank_memes_szn4: 0, //assigned later
          tdh_rank_memes_szn5: 0, //assigned later
          tdh_rank_memes_szn6: 0, //assigned later
          tdh_rank_gradients: 0, //assigned later
          tdh_rank_nextgen: 0, //assigned later
          block: block,
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
          ...memesData,
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
          nextgen_ranks: []
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
    `[BLOCK ${block}] [WALLETS ${walletsTDH.length}] [CALCULATING RANKS]`
  );

  const boostedTdh = await calculateBoosts(walletsTDH);

  const sortedTdh = await calculateRanks(
    allGradientsTDH,
    allNextgenTDH,
    boostedTdh,
    ADJUSTED_NFTS,
    NEXTGEN_NFTS
  );

  logger.info(
    `[BLOCK ${block}] [WALLETS ${sortedTdh.length}] [CALCULATING TDH - END]`
  );

  await persistTDH(block, timestamp, sortedTdh);

  return {
    block: block,
    timestamp: timestamp,
    tdh: sortedTdh
  };
};

export function calculateBoost(
  cardSets: number,
  uniqueS1: number,
  uniqueS2: number,
  uniqueS3: number,
  uniqueS4: number,
  uniqueS5: number,
  genesis: boolean,
  nakamoto: boolean,
  gradients: any[],
  hasENS: boolean,
  hasProfile: boolean
) {
  let boost = 1;

  // Category A
  if (cardSets > 0) {
    boost += 0.25;
    // additional full sets up to 2
    boost += Math.min((cardSets - 1) * 0.02, 0.04);
  }

  const cardSetS1 = uniqueS1 == SZN1_INDEX.count;
  const cardSetS2 = uniqueS2 == SZN2_INDEX.count;
  const cardSetS3 = uniqueS3 == SZN3_INDEX.count;
  const cardSetS4 = uniqueS4 == SZN4_INDEX.count;
  const cardSetS5 = uniqueS5 == SZN5_INDEX.count;

  // Category B
  if (cardSets == 0) {
    if (cardSetS1) {
      boost += 0.05;
    } else {
      if (genesis) {
        boost += 0.01;
      }
      // NAKAMOTO
      if (nakamoto) {
        boost += 0.01;
      }
    }
    if (cardSetS2) {
      boost += 0.05;
    }
    if (cardSetS3) {
      boost += 0.05;
    }
    if (cardSetS4) {
      boost += 0.05;
    }
    if (cardSetS5) {
      boost += 0.05;
    }
  }

  // gradients up to 3
  boost += Math.min(gradients.length * 0.02, 0.06);

  // ENS
  if (hasENS) {
    boost += 0.01;
  }

  // Profile
  if (hasProfile) {
    boost += 0.03;
  }

  return Math.round(boost * 100) / 100;
}

function getTokenTdh(
  lastTDHCalc: Date,
  id: number,
  hodlRate: number,
  wallet: string,
  consolidations: string[],
  tokenConsolidatedTransactions: Transaction[],
  nextgen?: boolean
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

export async function calculateBoosts(walletsTDH: any[]) {
  const boostedTDH: any[] = [];

  const profiles = await fetchAllProfiles();

  await Promise.all(
    walletsTDH.map(async (w) => {
      const hasENS = await fetchHasEns(w.wallets ? w.wallets : [w.wallet]);

      const hasProfile = profiles.some((p) =>
        w.wallets
          ? w.wallets.some((wallet: string) =>
              areEqualAddresses(wallet, p.primary_wallet)
            )
          : areEqualAddresses(w.wallet, p.primary_wallet)
      );

      const boost = calculateBoost(
        w.memes_cards_sets,
        w.unique_memes_season1,
        w.unique_memes_season2,
        w.unique_memes_season3,
        w.unique_memes_season4,
        w.unique_memes_season5,
        w.genesis,
        w.memes.some((m: any) => m.id == 4),
        w.gradients,
        hasENS,
        hasProfile
      );

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
  const sortedGradientsTdh = allGradientsTDH
    .sort((a, b) => {
      if (a.tdh > b.tdh) {
        return -1;
      } else if (a.tdh < b.tdh) {
        return 1;
      } else {
        return a.id > b.id ? 1 : -1;
      }
    })
    .map((a, index) => {
      a.rank = index + 1;
      return a;
    });

  const sortedNextgenTdh = allNextgenTDH.sort((a, b) => {
    if (a.tdh > b.tdh) {
      return -1;
    } else if (a.tdh < b.tdh) {
      return 1;
    } else {
      return a.id > b.id ? 1 : -1;
    }
  });
  const rankedNextgenTdh = sortedNextgenTdh.map((a, index) => {
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
              rank: sortedGradientsTdh.find((s) => s.id == nft.id)?.rank
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

  NEXTGEN_NFTS.forEach((nft) => {
    boostedTDH
      .filter((w) => w.nextgen.some((n: any) => n.id == nft.id && n.tdh > 0))
      .forEach((w) => {
        const nextgen = w.nextgen.find((g: any) => g.id == nft.id);
        if (nextgen) {
          w.nextgen_ranks.push({
            id: nft.id,
            rank: rankedNextgenTdh.find((s) => s.id == nft.id)?.rank
          });
        }
        return w;
      });
  });

  let sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_tdh > b.boosted_tdh) return -1;
      else if (a.boosted_tdh < b.boosted_tdh) return 1;
      else if (a.tdh > b.tdh) return -1;
      else if (a.tdh < b.tdh) return 1;
      else if (a.memes_tdh_season1 > b.memes_tdh_season1) return -1;
      else if (a.memes_tdh_season1 < b.memes_tdh_season1) return 1;
      else if (a.memes_tdh_season2 > b.memes_tdh_season2) return -1;
      else if (a.memes_tdh_season2 < b.memes_tdh_season2) return 1;
      else if (a.memes_tdh_season3 > b.memes_tdh_season3) return -1;
      else if (a.memes_tdh_season3 < b.memes_tdh_season3) return 1;
      else if (a.memes_tdh_season4 > b.memes_tdh_season4) return -1;
      else if (a.memes_tdh_season4 < b.memes_tdh_season4) return 1;
      else if (a.memes_tdh_season5 > b.memes_tdh_season5) return -1;
      else if (a.memes_tdh_season5 < b.memes_tdh_season5) return 1;
      else if (a.memes_tdh_season6 > b.memes_tdh_season6) return -1;
      else if (a.memes_tdh_season6 < b.memes_tdh_season6) return 1;
      else if (a.gradients_tdh > b.gradients_tdh) return -1;
      else if (a.gradients_tdh < b.gradients_tdh) return 1;
      else if (a.nextgen_tdh > b.nextgen_tdh) return -1;
      else if (a.nextgen_tdh < b.nextgen_tdh) return 1;
      else return -1;
    })
    .map((w, index) => {
      w.tdh_rank = index + 1;
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh > b.boosted_memes_tdh) return -1;
      else if (a.boosted_memes_tdh < b.boosted_memes_tdh) return 1;
      else if (a.memes_tdh > b.memes_tdh) return -1;
      else if (a.memes_tdh < b.memes_tdh) return 1;
      else if (a.memes_balance > b.memes_balance) return -1;
      else if (a.memes_balance < b.memes_balance) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh > 0) {
        w.tdh_rank_memes = index + 1;
      } else {
        w.tdh_rank_memes = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season1 > b.boosted_memes_tdh_season1) return -1;
      else if (a.boosted_memes_tdh_season1 < b.boosted_memes_tdh_season1)
        return 1;
      else if (a.memes_tdh_season1 > b.memes_tdh_season1) return -1;
      else if (a.memes_tdh_season1 < b.memes_tdh_season1) return 1;
      else if (a.memes_balance_season1 > b.memes_balance_season1) return -1;
      else if (a.memes_balance_season1 < b.memes_balance_season1) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season1 > 0) {
        w.tdh_rank_memes_szn1 = index + 1;
      } else {
        w.tdh_rank_memes_szn1 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season2 > b.boosted_memes_tdh_season2) return -1;
      else if (a.boosted_memes_tdh_season2 < b.boosted_memes_tdh_season2)
        return 1;
      else if (a.memes_tdh_season2 > b.memes_tdh_season2) return -1;
      else if (a.memes_tdh_season2 < b.memes_tdh_season2) return 1;
      else if (a.memes_balance_season2 > b.memes_balance_season2) return -1;
      else if (a.memes_balance_season2 < b.memes_balance_season2) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season2 > 0) {
        w.tdh_rank_memes_szn2 = index + 1;
      } else {
        w.tdh_rank_memes_szn2 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season3 > b.boosted_memes_tdh_season3) return -1;
      else if (a.boosted_memes_tdh_season3 < b.boosted_memes_tdh_season3)
        return 1;
      else if (a.memes_tdh_season3 > b.memes_tdh_season3) return -1;
      else if (a.memes_tdh_season3 < b.memes_tdh_season3) return 1;
      else if (a.memes_balance_season3 > b.memes_balance_season3) return -1;
      else if (a.memes_balance_season3 < b.memes_balance_season3) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season3 > 0) {
        w.tdh_rank_memes_szn3 = index + 1;
      } else {
        w.tdh_rank_memes_szn3 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season4 > b.boosted_memes_tdh_season4) return -1;
      else if (a.boosted_memes_tdh_season4 < b.boosted_memes_tdh_season4)
        return 1;
      else if (a.memes_tdh_season4 > b.memes_tdh_season4) return -1;
      else if (a.memes_tdh_season4 < b.memes_tdh_season4) return 1;
      else if (a.memes_balance_season4 > b.memes_balance_season4) return -1;
      else if (a.memes_balance_season4 < b.memes_balance_season4) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season4 > 0) {
        w.tdh_rank_memes_szn4 = index + 1;
      } else {
        w.tdh_rank_memes_szn4 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season5 > b.boosted_memes_tdh_season5) return -1;
      else if (a.boosted_memes_tdh_season5 < b.boosted_memes_tdh_season5)
        return 1;
      else if (a.memes_tdh_season5 > b.memes_tdh_season5) return -1;
      else if (a.memes_tdh_season5 < b.memes_tdh_season5) return 1;
      else if (a.memes_balance_season5 > b.memes_balance_season5) return -1;
      else if (a.memes_balance_season5 < b.memes_balance_season5) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season5 > 0) {
        w.tdh_rank_memes_szn5 = index + 1;
      } else {
        w.tdh_rank_memes_szn5 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_memes_tdh_season6 > b.boosted_memes_tdh_season6) return -1;
      else if (a.boosted_memes_tdh_season6 < b.boosted_memes_tdh_season6)
        return 1;
      else if (a.memes_tdh_season6 > b.memes_tdh_season6) return -1;
      else if (a.memes_tdh_season6 < b.memes_tdh_season6) return 1;
      else if (a.memes_balance_season6 > b.memes_balance_season6) return -1;
      else if (a.memes_balance_season6 < b.memes_balance_season6) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_memes_tdh_season6 > 0) {
        w.tdh_rank_memes_szn6 = index + 1;
      } else {
        w.tdh_rank_memes_szn6 = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_gradients_tdh > b.boosted_gradients_tdh) return -1;
      else if (a.boosted_gradients_tdh < b.boosted_gradients_tdh) return 1;
      else if (a.gradients_tdh > b.gradients_tdh) return -1;
      else if (a.gradients_tdh < b.gradients_tdh) return 1;
      else if (a.gradients_balance > b.gradients_balance) return -1;
      else if (a.gradients_balance < b.gradients_balance) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_gradients_tdh > 0) {
        w.tdh_rank_gradients = index + 1;
      } else {
        w.tdh_rank_gradients = -1;
      }
      return w;
    });

  sortedTdh = boostedTDH
    .sort((a: TDH, b: TDH) => {
      if (a.boosted_nextgen_tdh > b.boosted_nextgen_tdh) return -1;
      else if (a.boosted_nextgen_tdh < b.boosted_nextgen_tdh) return 1;
      else if (a.nextgen_tdh > b.nextgen_tdh) return -1;
      else if (a.nextgen_tdh < b.nextgen_tdh) return 1;
      else if (a.nextgen_balance > b.nextgen_balance) return -1;
      else if (a.nextgen_balance < b.nextgen_balance) return 1;
      else if (a.balance > b.balance) return -1;
      else return -1;
    })
    .map((w, index) => {
      if (w.boosted_nextgen_tdh > 0) {
        w.tdh_rank_nextgen = index + 1;
      } else {
        w.tdh_rank_nextgen = -1;
      }
      return w;
    });

  return sortedTdh;
}
