import { Seed } from '../_setup/seed';
import { CONSOLIDATED_WALLETS_TDH_TABLE } from '@/constants';
import { Time } from '@/time';
import { ConsolidatedTDH } from '@/entities/ITDH';

const defaultTdhConsolidation: Omit<
  ConsolidatedTDH,
  'consolidation_key' | 'consolidation_display' | 'wallets'
> = {
  date: Time.epoch().toDate(),
  block: 0,
  boost: 0,
  tdh_rank: 0,
  tdh_rank_memes: 0,
  tdh_rank_gradients: 0,
  balance: 0,
  genesis: 0,
  memes_cards_sets: 0,
  unique_memes: 0,
  memes_balance: 0,
  memes: [],
  memes_ranks: [],
  gradients_balance: 0,
  gradients: [],
  gradients_ranks: [],
  tdh_rank_nextgen: 0,
  nextgen_balance: 0,
  nextgen: [],
  nextgen_ranks: [],
  boost_breakdown: [],
  nakamoto: 0,
  tdh: 0,
  boosted_tdh: 0,
  tdh__raw: 0,
  boosted_memes_tdh: 0,
  memes_tdh: 0,
  memes_tdh__raw: 0,
  boosted_gradients_tdh: 0,
  gradients_tdh: 0,
  gradients_tdh__raw: 0,
  boosted_nextgen_tdh: 0,
  nextgen_tdh: 0,
  nextgen_tdh__raw: 0,
  boosted_tdh_rate: 1
};

export function aTdhConsolidation(
  wallets: string[],
  params?: Partial<
    Omit<
      ConsolidatedTDH,
      'consolidation_key' | 'consolidation_display' | 'wallets'
    >
  >
): ConsolidatedTDH {
  const key = wallets.join('-');
  return {
    ...defaultTdhConsolidation,
    ...params,
    consolidation_key: key,
    consolidation_display: key,
    wallets: wallets
  };
}

export function withTdhConsolidations(entities: ConsolidatedTDH[]): Seed {
  return {
    table: CONSOLIDATED_WALLETS_TDH_TABLE,
    rows: entities
  };
}
