import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MANIFOLD,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  PUNK_6529
} from '../constants';
import { TDH } from '../entities/ITDH';
import { Transaction } from '../entities/ITransaction';
import { areEqualAddresses, getDaysDiff } from '../helpers';
import { Alchemy } from 'alchemy-sdk';
import {
  fetchLatestTransactionsBlockNumber,
  fetchAllNFTs,
  fetchWalletTransactions,
  persistTDH,
  fetchTdhReplayOwners
} from '../db';
import { OwnerMetric } from '../entities/IOwner';

let alchemy: Alchemy;

export const findTDH = async (lastTDHCalc: Date) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const block = await fetchLatestTransactionsBlockNumber(lastTDHCalc);
  const nfts = await fetchAllNFTs();
  const allOwners: { from_address: string; to_address: string }[] =
    await fetchTdhReplayOwners(lastTDHCalc);

  const ownersSet = new Set(
    allOwners.flatMap((owner) => [owner.from_address, owner.to_address])
  );

  const owners = Array.from(ownersSet)
    .filter((o) => !areEqualAddresses(NULL_ADDRESS, o))
    .map((address) => ({ wallet: address }));

  const ADJUSTED_NFTS = [...nfts].filter(
    (nft) =>
      lastTDHCalc.getTime() - 28 * 60 * 60 * 1000 >
      new Date(nft.mint_date).getTime()
  );

  const MEMES_COUNT = [...ADJUSTED_NFTS].filter((nft) =>
    areEqualAddresses(nft.contract, MEMES_CONTRACT)
  ).length;

  const walletsTDH: TDH[] = [];
  const ownerMetrics: OwnerMetric[] = [];

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
      const walletMemes: any[] = [];
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
      let gradientsBalance = 0;
      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;

      const walletTransactions: Transaction[] = await fetchWalletTransactions(
        wallet,
        block
      );

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

        let tokenWalletTransactions = [...tokenTransactions]
          .filter(
            (tr) =>
              areEqualAddresses(tr.to_address, wallet) ||
              areEqualAddresses(tr.from_address, wallet)
          )
          .sort((a, b) => {
            return (
              new Date(a.transaction_date).getTime() -
              new Date(b.transaction_date).getTime()
            );
          });

        const walletTokens: Date[] = [];

        tokenWalletTransactions.map((t) => {
          if (areEqualAddresses(t.to_address, wallet)) {
            Array.from({ length: t.token_count }, () => {
              walletTokens.push(new Date(t.transaction_date));
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
            }
            if (season == 2) {
              memes_tdh_season2 += tdh;
              memes_tdh_season2__raw += tdh__raw;
              memes_balance_season2 += balance;
            }
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
          tdh_rank_gradients: 0, //assigned later
          block: block,
          tdh: totalTDH,
          boost: 0,
          boosted_tdh: 0,
          tdh__raw: totalTDH__raw,
          balance: totalBalance,
          memes_cards_sets: memesCardSets,
          genesis: genesis,
          unique_memes: walletMemes.length,
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
        ownerMetrics.push(
          getOwnerMetric(wallet, lastTDHCalc, walletTransactions)
        );
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

  const boostedTDH: TDH[] = [];

  walletsTDH.map((w) => {
    const boost = calculateBoost(
      MEMES_COUNT,
      w.memes_cards_sets,
      w.genesis,
      w.memes,
      w.gradients
    );
    w.boost = boost;
    w.boosted_tdh = w.tdh * boost;
    w.boosted_memes_tdh = w.memes_tdh * boost;
    w.boosted_memes_tdh_season1 = w.memes_tdh_season1 * boost;
    w.boosted_memes_tdh_season2 = w.memes_tdh_season2 * boost;
    w.boosted_gradients_tdh = w.gradients_tdh * boost;
    boostedTDH.push(w);
  });

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

  console.log(
    new Date(),
    '[TDH]',
    `[BLOCK ${block}]`,
    `[WALLETS ${walletsTDH.length}]`,
    '[CALCULATING TDH - END]'
  );

  await persistTDH(block, timestamp, sortedTdh);

  return {
    block: block,
    date: lastTDHCalc,
    tdh: sortedTdh,
    ownerMetrics: ownerMetrics
  };
};

function calculateBoost(
  memesCount: number,
  cardSets: number,
  genesis: boolean,
  memes: any[],
  gradients: any[]
) {
  if (cardSets > 0) {
    let boost = 1.2;
    boost += (cardSets - 1) * 0.02;
    boost += gradients.length * 0.02;
    return Math.min(1.3, boost);
  }

  if (memes.length == memesCount - 1) {
    return 1.05;
  }
  if (memes.length == memesCount - 2) {
    return 1.04;
  }
  if (memes.length == memesCount - 3) {
    return 1.03;
  }
  if (memes.length == memesCount - 4) {
    return 1.02;
  }
  if (genesis) {
    return 1.02;
  }
  if (memes.length == memesCount - 5) {
    return 1.01;
  }
  return 1;
}

function getOwnerMetric(
  wallet: string,
  lastTDHCalc: Date,
  walletTransactions: Transaction[]
) {
  const transactionsIn = [...walletTransactions].filter((wt) =>
    areEqualAddresses(wt.to_address, wallet)
  );
  const transactionsOut = [...walletTransactions].filter((wt) =>
    areEqualAddresses(wt.from_address, wallet)
  );
  const memesTransactionsIn = [...transactionsIn].filter((tr) =>
    areEqualAddresses(tr.contract, MEMES_CONTRACT)
  );
  const memesTransactionsOut = [...transactionsOut].filter((tr) =>
    areEqualAddresses(tr.contract, MEMES_CONTRACT)
  );
  const memesTransactionsInSeason1 = [...memesTransactionsIn].filter(
    (tr) => 47 >= tr.token_id
  );
  const memesTransactionsOutSeason1 = [...memesTransactionsOut].filter(
    (tr) => 47 >= tr.token_id
  );
  const memesTransactionsInSeason2 = [...memesTransactionsIn].filter(
    (tr) => tr.token_id >= 48
  );
  const memesTransactionsOutSeason2 = [...memesTransactionsOut].filter(
    (tr) => tr.token_id >= 48
  );
  const gradientsTransactionsIn = [...transactionsIn].filter((tr) =>
    areEqualAddresses(tr.contract, GRADIENT_CONTRACT)
  );
  const gradientsTransactionsOut = [...transactionsOut].filter((tr) =>
    areEqualAddresses(tr.contract, GRADIENT_CONTRACT)
  );

  const purchases = [...transactionsIn].filter((t) => t.value > 0);
  const purchasesMemes = [...purchases].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const purchasesMemesS1 = [...purchasesMemes].filter((t) => 47 >= t.token_id);
  const purchasesMemesS2 = [...purchasesMemes].filter((t) => t.token_id >= 48);
  const purchasesGradients = [...purchases].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const purchasesPrimary = [...purchases].filter((t) =>
    areEqualAddresses(MANIFOLD, t.from_address)
  );
  const purchasesPrimaryMemes = [...purchasesPrimary].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const purchasesPrimaryMemesS1 = [...purchasesPrimaryMemes].filter(
    (t) => 47 >= t.token_id
  );
  const purchasesPrimaryMemesS2 = [...purchasesPrimaryMemes].filter(
    (t) => t.token_id >= 48
  );
  const purchasesPrimaryGradients = [...purchasesPrimary].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const purchasesSecondary = [...purchases].filter(
    (t) => !areEqualAddresses(MANIFOLD, t.from_address)
  );
  const purchasesSecondaryMemes = [...purchasesSecondary].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const purchasesSecondaryMemesS1 = [...purchasesSecondaryMemes].filter(
    (t) => 47 >= t.token_id
  );
  const purchasesSecondaryMemesS2 = [...purchasesSecondaryMemes].filter(
    (t) => t.token_id >= 48
  );
  const purchasesSecondaryGradients = [...purchasesSecondary].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const sales = [...transactionsOut].filter(
    (t) => t.value > 0 && !isPunkGradient(t)
  );
  const salesMemes = [...sales].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const salesMemesS1 = [...salesMemes].filter((t) => 47 >= t.token_id);
  const salesMemesS2 = [...salesMemes].filter((t) => t.token_id >= 48);
  const salesGradients = [...sales].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const transfersIn = [...transactionsIn].filter((t) => t.value == 0);
  const transfersInMemes = [...transfersIn].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const transfersInMemesS1 = [...transfersInMemes].filter(
    (t) => 47 >= t.token_id
  );
  const transfersInMemesS2 = [...transfersInMemes].filter(
    (t) => t.token_id >= 48
  );
  const transfersInGradients = [...transfersIn].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const transfersOut = [...transactionsOut].filter(
    (t) => t.value == 0 || isPunkGradient(t)
  );

  const transfersOutMemes = [...transfersOut].filter((t) =>
    areEqualAddresses(t.contract, MEMES_CONTRACT)
  );
  const transfersOutMemesS1 = [...transfersOutMemes].filter(
    (t) => 47 >= t.token_id
  );
  const transfersOutMemesS2 = [...transfersOutMemes].filter(
    (t) => t.token_id >= 48
  );
  const transfersOutGradients = [...transfersOut].filter((t) =>
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );

  const ownerMetric: OwnerMetric = {
    created_at: new Date(),
    wallet: wallet,
    balance: getCount(transactionsIn) - getCount(transactionsOut),
    memes_balance:
      getCount(memesTransactionsIn) - getCount(memesTransactionsOut),
    memes_balance_season1:
      getCount(memesTransactionsInSeason1) -
      getCount(memesTransactionsOutSeason1),
    memes_balance_season2:
      getCount(memesTransactionsInSeason2) -
      getCount(memesTransactionsOutSeason2),
    gradients_balance:
      getCount(gradientsTransactionsIn) - getCount(gradientsTransactionsOut),
    purchases_value: getValue(purchases),
    purchases_count: getCount(purchases),
    purchases_value_memes: getValue(purchasesMemes),
    purchases_count_memes: getCount(purchasesMemes),
    purchases_value_memes_season1: getValue(purchasesMemesS1),
    purchases_count_memes_season1: getCount(purchasesMemesS1),
    purchases_value_memes_season2: getValue(purchasesMemesS2),
    purchases_count_memes_season2: getCount(purchasesMemesS2),
    purchases_value_gradients: getValue(purchasesGradients),
    purchases_count_gradients: getCount(purchasesGradients),
    purchases_value_primary: getValue(purchasesPrimary),
    purchases_count_primary: getCount(purchasesPrimary),
    purchases_value_primary_memes: getValue(purchasesPrimaryMemes),
    purchases_count_primary_memes: getCount(purchasesPrimaryMemes),
    purchases_value_primary_memes_season1: getValue(purchasesPrimaryMemesS1),
    purchases_count_primary_memes_season1: getCount(purchasesPrimaryMemesS1),
    purchases_value_primary_memes_season2: getValue(purchasesPrimaryMemesS2),
    purchases_count_primary_memes_season2: getCount(purchasesPrimaryMemesS2),
    purchases_value_primary_gradients: getValue(purchasesPrimaryGradients),
    purchases_count_primary_gradients: getCount(purchasesPrimaryGradients),
    purchases_value_secondary: getValue(purchasesSecondary),
    purchases_count_secondary: getCount(purchasesSecondary),
    purchases_value_secondary_memes: getValue(purchasesSecondaryMemes),
    purchases_count_secondary_memes: getCount(purchasesSecondaryMemes),
    purchases_value_secondary_memes_season1: getValue(
      purchasesSecondaryMemesS1
    ),
    purchases_count_secondary_memes_season1: getCount(
      purchasesSecondaryMemesS1
    ),
    purchases_value_secondary_memes_season2: getValue(
      purchasesSecondaryMemesS2
    ),
    purchases_count_secondary_memes_season2: getCount(
      purchasesSecondaryMemesS2
    ),
    purchases_value_secondary_gradients: getValue(purchasesSecondaryGradients),
    purchases_count_secondary_gradients: getCount(purchasesSecondaryGradients),
    sales_value: getValue(sales),
    sales_count: getCount(sales),
    sales_value_memes: getValue(salesMemes),
    sales_count_memes: getCount(salesMemes),
    sales_value_memes_season1: getValue(salesMemesS1),
    sales_count_memes_season1: getCount(salesMemesS1),
    sales_value_memes_season2: getValue(salesMemesS2),
    sales_count_memes_season2: getCount(salesMemesS2),
    sales_value_gradients: getValue(salesGradients),
    sales_count_gradients: getCount(salesGradients),
    transfers_in: getCount(transfersIn),
    transfers_in_memes: getCount(transfersInMemes),
    transfers_in_memes_season1: getCount(transfersInMemesS1),
    transfers_in_memes_season2: getCount(transfersInMemesS2),
    transfers_in_gradients: getCount(transfersInGradients),
    transfers_out: getCount(transfersOut),
    transfers_out_memes: getCount(transfersOutMemes),
    transfers_out_memes_season1: getCount(transfersOutMemesS1),
    transfers_out_memes_season2: getCount(transfersOutMemesS2),
    transfers_out_gradients: getCount(transfersOutGradients),
    transaction_reference: lastTDHCalc
  };
  return ownerMetric;
}

function getCount(arr: any[]) {
  return [...arr].reduce(
    (sum, transaction) => sum + transaction.token_count,
    0
  );
}

function getValue(arr: any[]) {
  return [...arr].reduce((sum, transaction) => sum + transaction.value, 0);
}

function isPunkGradient(t: Transaction) {
  return (
    areEqualAddresses(t.from_address, PUNK_6529) &&
    areEqualAddresses(t.contract, GRADIENT_CONTRACT)
  );
}
