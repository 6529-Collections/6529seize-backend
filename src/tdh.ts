import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT
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
  fetchHasEns
} from './db';

let alchemy: Alchemy;

export const findTDH = async (lastTDHCalc: Date) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const block = await fetchLatestTransactionsBlockNumber(lastTDHCalc);
  const nfts = await fetchAllNFTs();
  const owners: { wallet: string }[] = await fetchAllOwnersAddresses();

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

  console.log(
    new Date(),
    '[TDH]',
    `[BLOCK ${block} - ${timestamp.toUTCString()}]`,
    `[LAST TDH ${lastTDHCalc.toUTCString()}]`,
    `[ADJUSTED_NFTS ${ADJUSTED_NFTS.length}]`,
    '[CALCULATING TDH - START]'
  );

  console.log(
    new Date(),
    '[TDH]',
    `[TRANSACTIONS UNIQUE WALLETS ${owners.length}]`
  );

  const allGradientsTDH: any[] = [];
  await Promise.all(
    owners.map(async (owner) => {
      const wallet = owner.wallet;
      const consolidations = await retrieveWalletConsolidations(wallet);

      const walletMemes: any[] = [];
      let unique_memes = 0;
      let unique_memes_season1 = 0;
      let unique_memes_season2 = 0;
      let unique_memes_season3 = 0;
      let unique_memes_season4 = 0;
      const walletGradients: any[] = [];

      let totalTDH = 0;
      let totalTDH__raw = 0;
      let totalBalance = 0;
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
      let gradientsBalance = 0;
      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;

      const walletTransactions: Transaction[] = consolidateTransactions(
        await fetchWalletTransactions(wallet, block)
      ).sort((a: Transaction, b: Transaction) => {
        return (
          new Date(a.transaction_date).getTime() -
          new Date(b.transaction_date).getTime()
        );
      });

      let consolidationTransactions: Transaction[] = [];
      await Promise.all(
        consolidations.map(async (c) => {
          if (!areEqualAddresses(c, wallet)) {
            const cTransactions = await fetchWalletTransactions(c, block);
            consolidationTransactions =
              consolidationTransactions.concat(cTransactions);
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

      const memesTransactions = [...walletTransactions].filter((t) =>
        areEqualAddresses(t.contract, MEMES_CONTRACT)
      );
      const gradientsTransactions = [...walletTransactions].filter((t) =>
        areEqualAddresses(t.contract, GRADIENT_CONTRACT)
      );

      ADJUSTED_NFTS.map((nft) => {
        let tokenTransactions: Transaction[] = [];
        if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
          tokenTransactions = [...memesTransactions].filter(
            (tr) => nft.id == tr.token_id
          );
        } else if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
          tokenTransactions = [...gradientsTransactions].filter(
            (tr) => nft.id == tr.token_id
          );
        }

        const walletTokens: Date[] = [];

        tokenTransactions.map((t) => {
          if (areEqualAddresses(t.to_address, wallet)) {
            let date = new Date(t.transaction_date);
            if (
              t.value == 0 &&
              consolidations.some((c) => areEqualAddresses(c, t.from_address))
            ) {
              date = getTokenDateFromConsolidation(
                consolidations,
                t,
                consolidationTransactions
              );
            }
            Array.from({ length: t.token_count }, () => {
              walletTokens.push(date);
            });
          }
          if (areEqualAddresses(t.from_address, wallet)) {
            Array.from({ length: t.token_count }, () => {
              walletTokens.pop();
            });
          }
        });

        let tdh__raw = 0;
        walletTokens.map((e) => {
          const daysDiff = getDaysDiff(lastTDHCalc, e);
          tdh__raw += daysDiff;
        });

        const balance = walletTokens.length;
        const tdh = tdh__raw * nft.hodl_rate;

        if (tdh > 0 && balance > 0) {
          totalTDH += tdh;
          totalTDH__raw += tdh__raw;
          totalBalance += balance;

          const tokenTDH = {
            id: nft.id,
            balance: balance,
            tdh: tdh,
            tdh__raw: tdh__raw
          };

          if (areEqualAddresses(nft.contract, MEMES_CONTRACT)) {
            memesTDH += tdh;
            memesTDH__raw += tdh__raw;
            const season = parseInt(
              nft.metadata.attributes.find(
                (a: any) => a.trait_type === 'Type - Season'
              )?.value
            );
            if (season == 1) {
              memes_tdh_season1 += tdh;
              memes_tdh_season1__raw += tdh__raw;
              memes_balance_season1 += balance;
              unique_memes_season1++;
            }
            if (season == 2) {
              memes_tdh_season2 += tdh;
              memes_tdh_season2__raw += tdh__raw;
              memes_balance_season2 += balance;
              unique_memes_season2++;
            }
            if (season == 3) {
              memes_tdh_season3 += tdh;
              memes_tdh_season3__raw += tdh__raw;
              memes_balance_season3 += balance;
              unique_memes_season3++;
            }
            if (season == 4) {
              memes_tdh_season4 += tdh;
              memes_tdh_season4__raw += tdh__raw;
              memes_balance_season4 += balance;
              unique_memes_season4++;
            }
            unique_memes++;
            memesBalance += balance;
            walletMemes.push(tokenTDH);
          } else if (areEqualAddresses(nft.contract, GRADIENT_CONTRACT)) {
            gradientsTDH += tdh;
            gradientsTDH__raw += tdh__raw;
            gradientsBalance += balance;
            walletGradients.push(tokenTDH);
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

      if (Math.round(totalTDH) > 0) {
        const tdh: TDH = {
          date: new Date(),
          wallet: wallet,
          tdh_rank: 0, //assigned later
          tdh_rank_memes: 0, //assigned later
          tdh_rank_memes_szn1: 0, //assigned later
          tdh_rank_memes_szn2: 0, //assigned later
          tdh_rank_memes_szn3: 0, //assigned later
          tdh_rank_memes_szn4: 0, //assigned later
          tdh_rank_gradients: 0, //assigned later
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
          memes: walletMemes,
          memes_ranks: [],
          boosted_gradients_tdh: 0,
          gradients_tdh: gradientsTDH,
          gradients_tdh__raw: gradientsTDH__raw,
          gradients_balance: gradientsBalance,
          gradients: walletGradients,
          gradients_ranks: []
        };
        walletGradients.map((wg) => {
          allGradientsTDH.push(wg);
        });
        walletsTDH.push(tdh);
      }
    })
  );

  console.log(
    new Date(),
    '[TDH]',
    `[BLOCK ${block}]`,
    `[WALLETS ${walletsTDH.length}]`,
    '[CALCULATING RANKS]'
  );

  const sortedTdh = await ranks(
    allGradientsTDH,
    walletsTDH,
    ADJUSTED_NFTS,
    MEMES_COUNT
  );

  console.log(
    new Date(),
    '[TDH]',
    `[BLOCK ${block}]`,
    `[WALLETS ${sortedTdh.length}]`,
    '[CALCULATING TDH - END]'
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
  cardSetsS1: number,
  cardSetsS2: number,
  cardSetsS3: number,
  cardSetsS4: number,
  genesis: boolean,
  nakamoto: boolean,
  gradients: any[],
  hasENS: boolean
) {
  let boost = 1;

  // Category A
  if (cardSets > 0) {
    boost += 0.2;
    // additional full sets up to 2
    boost += Math.min((cardSets - 1) * 0.02, 0.04);
  }

  // Category B
  if (cardSets == 0) {
    if (cardSetsS1 > 0) {
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
    if (cardSetsS2 > 0) {
      boost += 0.05;
    }
    if (cardSetsS3 > 0) {
      boost += 0.05;
    }
  }

  // gradients up to 3
  boost += Math.min(gradients.length * 0.02, 0.06);

  // ENS
  if (hasENS) {
    boost += 0.02;
  }

  return Math.round(boost * 100) / 100;
}

function getTokenDateFromConsolidation(
  consolidations: string[],
  transaction: Transaction,
  consolidationTransactions: Transaction[]
): Date {
  const firstTransactionInConsolidation = consolidationTransactions
    .sort(
      (a, b) =>
        new Date(a.transaction_date).getTime() -
        new Date(b.transaction_date).getTime()
    )
    .find(
      (t) =>
        t.token_id == transaction.token_id &&
        consolidations.some((c) => areEqualAddresses(c, t.to_address)) &&
        !consolidations.some((c) => areEqualAddresses(c, t.from_address))
    );

  if (firstTransactionInConsolidation) {
    return new Date(firstTransactionInConsolidation.transaction_date);
  }
  return new Date(transaction.transaction_date);
}

export async function ranks(
  allGradientsTDH: any[],
  walletsTDH: any[],
  ADJUSTED_NFTS: any[],
  MEMES_COUNT: number
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

  const boostedTDH: any[] = [];

  await Promise.all(
    walletsTDH.map(async (w) => {
      const hasENS = await fetchHasEns(w.wallets ? w.wallets : [w.wallet]);

      const boost = calculateBoost(
        w.memes_cards_sets,
        w.memesCardSetsSzn1,
        w.memesCardSetsSzn2,
        w.memesCardSetsSzn3,
        w.memesCardSetsSzn4,
        w.genesis,
        w.memes.some((m: any) => m.id == 4),
        w.gradients,
        hasENS
      );

      w.boost = boost;
      w.boosted_tdh = w.tdh * boost;
      w.boosted_memes_tdh = w.memes_tdh * boost;
      w.boosted_memes_tdh_season1 = w.memes_tdh_season1 * boost;
      w.boosted_memes_tdh_season2 = w.memes_tdh_season2 * boost;
      w.boosted_memes_tdh_season3 = w.memes_tdh_season3 * boost;
      w.boosted_memes_tdh_season4 = w.memes_tdh_season4 * boost;
      w.boosted_gradients_tdh = w.gradients_tdh * boost;
      boostedTDH.push(w);
    })
  );

  ADJUSTED_NFTS.map((nft) => {
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
      .map((w, index) => {
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
      const wallets = [...walletsTDH].filter((w) =>
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
      else if (a.gradients_tdh > b.gradients_tdh) return -1;
      else if (a.gradients_tdh < b.gradients_tdh) return 1;
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

  return sortedTdh;
}
