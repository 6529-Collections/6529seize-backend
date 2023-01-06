import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NULL_ADDRESS
} from './constants';
import { NFT } from './entities/INFT';
import { TDH } from './entities/ITDH';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses, getDaysDiff } from './helpers';
import { Alchemy } from 'alchemy-sdk';

const alchemy = new Alchemy(ALCHEMY_SETTINGS);

export const findTDH = async (
  block: number,
  lastTDHCalc: Date,
  nfts: NFT[],
  owners: { wallet: string }[],
  db: any
) => {
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

      const walletTransactions: Transaction[] =
        await db.fetchWalletTransactions(wallet, block);
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
          block: block,
          tdh: totalTDH,
          boost: 0,
          boosted_tdh: 0,
          tdh__raw: totalTDH__raw,
          balance: totalBalance,
          memes_cards_sets: memesCardSets,
          genesis: genesis,
          unique_memes: walletMemes.length,
          memes_tdh: memesTDH,
          memes_tdh__raw: memesTDH__raw,
          memes_balance: memesBalance,
          memes_tdh_season1: memes_tdh_season1,
          memes_tdh_season1__raw: memes_tdh_season1__raw,
          memes_balance_season1: memes_balance_season1,
          memes_tdh_season2: memes_tdh_season2,
          memes_tdh_season2__raw: memes_tdh_season2__raw,
          memes_balance_season2: memes_balance_season2,
          memes: walletMemes,
          memes_ranks: [],
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

  ADJUSTED_NFTS.map((nft) => {
    walletsTDH
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
        }
        return 1;
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
        return 1;
      }).map;
    }
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
    boostedTDH.push(w);
  });

  const sortedTdh = boostedTDH
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

  console.log(
    new Date(),
    '[TDH]',
    `[BLOCK ${block}]`,
    `[WALLETS ${walletsTDH.length}]`,
    '[CALCULATING TDH - END]'
  );

  return {
    block: block,
    timestamp: timestamp,
    tdh: sortedTdh
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
