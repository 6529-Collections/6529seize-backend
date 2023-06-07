import { ConsolidatedTDH, TDHENS } from './entities/ITDH';
import {
  retrieveWalletConsolidations,
  fetchAllTDH,
  fetchAllNFTs,
  persistConsolidatedTDH,
  fetchConsolidationDisplay
} from './db';
import { areEqualAddresses } from './helpers';
import { ranks } from './tdh';
import { MEMES_CONTRACT } from './constants';

export const consolidateTDH = async (lastTDHCalc: Date) => {
  const tdh: TDHENS[] = await fetchAllTDH();
  const nfts = await fetchAllNFTs();

  const ADJUSTED_NFTS = [...nfts].filter(
    (nft) =>
      lastTDHCalc.getTime() - 28 * 60 * 60 * 1000 >
      new Date(nft.mint_date).getTime()
  );

  const MEMES_COUNT = [...ADJUSTED_NFTS].filter((nft) =>
    areEqualAddresses(nft.contract, MEMES_CONTRACT)
  ).length;

  console.log('[TDH CONSOLIDATION]', `[WALLETS ${tdh.length}]`);

  const consolidatedTdh: ConsolidatedTDH[] = [];
  const processedWallets = new Set<string>();
  const allGradientsTDH: any[] = [];

  await Promise.all(
    tdh.map(async (tdhEntry) => {
      const wallet = tdhEntry.wallet;
      const consolidations = await retrieveWalletConsolidations(wallet);
      const display = await fetchConsolidationDisplay(consolidations);

      if (
        !Array.from(processedWallets).some((pw) =>
          areEqualAddresses(wallet, pw)
        )
      ) {
        const consolidatedWalletsTdh = [...tdh].filter((t) =>
          consolidations.some((c) => areEqualAddresses(c, t.wallet))
        );

        let totalTDH = 0;
        let totalTDH__raw = 0;
        let totalBalance = 0;
        let genesis = false;
        let unique_memes = 0;
        let unique_memes_season1 = 0;
        let unique_memes_season2 = 0;
        let unique_memes_season3 = 0;
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
        let gradientsTDH = 0;
        let gradientsTDH__raw = 0;
        let gradientsBalance = 0;
        let consolidationMemes: any[] = [];
        let consolidationGradients: any[] = [];

        consolidatedWalletsTdh.map((wTdh) => {
          totalTDH += wTdh.tdh;
          totalTDH__raw += wTdh.tdh__raw;
          totalBalance += wTdh.balance;
          genesis = genesis || wTdh.genesis;
          unique_memes += wTdh.unique_memes;
          unique_memes_season1 += wTdh.unique_memes_season1;
          unique_memes_season2 += wTdh.unique_memes_season2;
          unique_memes_season3 += wTdh.unique_memes_season3;
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

        const consolidation: ConsolidatedTDH = {
          date: new Date(),
          consolidation_display: display,
          wallets: consolidations,
          tdh_rank: 0, //assigned later
          tdh_rank_memes: 0, //assigned later
          tdh_rank_memes_szn1: 0, //assigned later
          tdh_rank_memes_szn2: 0, //assigned later
          tdh_rank_memes_szn3: 0, //assigned later
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
          memes: consolidationMemes,
          memes_ranks: [],
          boosted_gradients_tdh: 0,
          gradients_tdh: gradientsTDH,
          gradients_tdh__raw: gradientsTDH__raw,
          gradients_balance: gradientsBalance,
          gradients: consolidationGradients,
          gradients_ranks: []
        };
        consolidationGradients.map((wg) => {
          allGradientsTDH.push(wg);
        });
        consolidatedTdh.push(consolidation);
      }
      consolidations.map((c) => {
        processedWallets.add(c);
      });
    })
  );

  const sortedConsolidatedTdh = ranks(
    allGradientsTDH,
    consolidatedTdh,
    ADJUSTED_NFTS,
    MEMES_COUNT
  );

  await persistConsolidatedTDH(sortedConsolidatedTdh);

  console.log(
    '[TDH CONSOLIDATION]',
    `[FINAL ENTRIES ${sortedConsolidatedTdh.length}]`
  );
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
