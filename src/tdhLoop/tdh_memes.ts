import { MemesSeason } from '../entities/ISeason';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  TDH,
  TDHMemes,
  TokenTDH
} from '../entities/ITDH';
import { Logger } from '../logging';

const logger = Logger.get('TDH_MEMES');

export async function calculateMemesTdh<T extends TDH | ConsolidatedTDH>(
  seasons: MemesSeason[],
  tdh: T[],
  isConsolidation?: boolean
): Promise<(TDHMemes | ConsolidatedTDHMemes)[]> {
  const tdhWithMemes = tdh.filter((t) => t.memes_balance > 0);
  logger.info(
    `[FOUND ${tdhWithMemes.length} WALLETS WITH MEMES] : [TOTAL WALLETS ${tdh.length}] : [SEASONS ${seasons.length}]`
  );

  const memesTdh: (TDHMemes | ConsolidatedTDHMemes)[] = [];

  tdhWithMemes.forEach((t: any) => {
    seasons.forEach((s) => {
      const seasonMemes = t.memes.filter(
        (m: TokenTDH) => s.start_index <= m.id && m.id <= s.end_index
      );

      interface BoostedTokenTDH extends TokenTDH {
        boosted_tdh: number;
      }

      const memeTotals = seasonMemes.reduce(
        (acc: BoostedTokenTDH, cp: TokenTDH) => {
          acc.balance += cp.balance;
          acc.tdh += cp.tdh;
          acc.tdh__raw += cp.tdh__raw;
          acc.boosted_tdh += Math.round(cp.tdh * t.boost);
          return acc;
        },
        {
          balance: 0,
          tdh: 0,
          tdh__raw: 0,
          boosted_tdh: 0
        }
      );
      const uniqueMemes = seasonMemes.length;
      let sets = 0;
      if (uniqueMemes === s.count) {
        sets = Math.min(
          ...[...seasonMemes].map(function (o) {
            return o.balance;
          })
        );
      }

      const shared = {
        season: s.id,
        balance: memeTotals.balance,
        tdh: memeTotals.tdh,
        tdh__raw: memeTotals.tdh__raw,
        boost: t.boost,
        boosted_tdh: memeTotals.boosted_tdh,
        unique_memes: uniqueMemes,
        memes_cards_sets: sets,
        tdh_rank: 0 //assigned later
      };

      const tdhMemes: TDHMemes | ConsolidatedTDHMemes = isConsolidation
        ? {
            consolidation_key: t.consolidation_key,
            ...shared
          }
        : {
            wallet: t.wallet,
            ...shared
          };

      memesTdh.push(tdhMemes);
    });
  });

  logger.info(`[CALCULATED ${memesTdh.length} MEMES TDH] : [SORTING...]`);

  const rankedMemesTdh = rank(memesTdh);
  logger.info(`[SORTED ${rankedMemesTdh.length} MEMES TDH]`);
  if (isConsolidation) {
    return rankedMemesTdh as ConsolidatedTDHMemes[];
  } else {
    return rankedMemesTdh as TDHMemes[];
  }
}

function rank(memesTdh: (TDHMemes | ConsolidatedTDHMemes)[]) {
  memesTdh.sort((a, b) => {
    if (a.season !== b.season) {
      return a.season - b.season;
    } else if (b.boosted_tdh - a.boosted_tdh !== 0) {
      return b.boosted_tdh - a.boosted_tdh;
    } else {
      return b.balance - a.balance;
    }
  });

  let currentSeason = 0;
  let rank = 1;
  const rankedMemesTdh = memesTdh.map((t, i, arr) => {
    if (t.season !== currentSeason) {
      currentSeason = t.season;
      rank = 1;
    }
    if (
      i > 0 &&
      arr[i - 1].season === t.season &&
      arr[i - 1].boosted_tdh === t.boosted_tdh &&
      arr[i - 1].balance === t.balance
    ) {
      t.tdh_rank = arr[i - 1].tdh_rank;
    } else {
      t.tdh_rank = rank;
      rank++;
    }

    return t;
  });
  return rankedMemesTdh;
}
