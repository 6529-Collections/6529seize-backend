import { ConsolidatedTDH } from '@/entities/ITDH';

/** A consolidated TDH row of one wallet, as the TDH loop writes it. */
export function consolidatedTdhRow(
  wallet: string,
  tdh: number
): ConsolidatedTDH {
  return consolidatedTdhRowOf(wallet, [wallet], tdh);
}

/**
 * A consolidated TDH row of a consolidation key and its wallets, as the
 * TDH loop writes it.
 */
export function consolidatedTdhRowOf(
  consolidationKey: string,
  wallets: readonly string[],
  tdh: number
): ConsolidatedTDH {
  return {
    consolidation_key: consolidationKey,
    consolidation_display: consolidationKey,
    wallets: [...wallets],
    block: 1,
    date: new Date(Date.UTC(2026, 10, 23)),
    balance: 1,
    unique_memes: 1,
    memes_cards_sets: 0,
    tdh,
    boost: 1,
    boosted_tdh: tdh,
    tdh__raw: tdh,
    tdh_rank: 1,
    tdh_rank_memes: 1,
    tdh_rank_gradients: 0,
    tdh_rank_nextgen: 0,
    genesis: 0,
    nakamoto: 0,
    boosted_memes_tdh: tdh,
    memes_tdh: tdh,
    memes_tdh__raw: tdh,
    memes_balance: 1,
    memes: [],
    memes_ranks: [],
    gradients_balance: 0,
    boosted_gradients_tdh: 0,
    gradients_tdh: 0,
    gradients_tdh__raw: 0,
    gradients: [],
    gradients_ranks: [],
    nextgen_balance: 0,
    boosted_nextgen_tdh: 0,
    nextgen_tdh: 0,
    nextgen_tdh__raw: 0,
    nextgen: [],
    nextgen_ranks: [],
    boost_breakdown: null,
    boosted_tdh_rate: 0
  };
}
