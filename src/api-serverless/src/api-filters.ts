export const DISTRIBUTION_SORT = [
  'phase',
  'card_mint_count',
  'count',
  'wallet_tdh',
  'wallet_balance',
  'wallet_unique_balance'
];

export const NFT_TDH_SORT = [
  'card_tdh',
  'card_tdh__raw',
  'card_balance',
  'total_tdh',
  'total_balance',
  'total_tdh__raw'
];

export const REMEMES_SORT = ['created_at'];

export const MEME_LAB_OWNERS_SORT = ['balance'];

export const TDH_SORT = [
  'boosted_tdh',
  'tdh',
  'tdh__raw',
  'tdh_rank',
  'boosted_memes_tdh',
  'memes_tdh',
  'memes_tdh__raw',
  'boosted_memes_tdh_season1',
  'memes_tdh_season1',
  'memes_tdh_season1__raw',
  'boosted_memes_tdh_season2',
  'memes_tdh_season2',
  'memes_tdh_season2__raw',
  'boosted_memes_tdh_season3',
  'memes_tdh_season3',
  'memes_tdh_season3__raw',
  'boosted_memes_tdh_season4',
  'memes_tdh_season4',
  'memes_tdh_season4__raw',
  'boosted_memes_tdh_season5',
  'memes_tdh_season5',
  'memes_tdh_season5__raw',
  'boosted_memes_tdh_season6',
  'memes_tdh_season6',
  'memes_tdh_season6__raw',
  'memes_balance',
  'memes_balance_season1',
  'memes_balance_season2',
  'memes_balance_season3',
  'memes_balance_season4',
  'memes_balance_season5',
  'memes_balance_season6',
  'boosted_gradients_tdh',
  'gradients_tdh',
  'gradients_tdh__raw',
  'gradients_balance',
  'balance',
  'purchases_value',
  'purchases_count',
  'sales_value',
  'sales_count',
  'purchases_value_memes',
  'purchases_value_memes_season1',
  'purchases_value_memes_season2',
  'purchases_value_memes_season3',
  'purchases_value_memes_season4',
  'purchases_value_memes_season5',
  'purchases_value_memes_season6',
  'purchases_value_gradients',
  'purchases_count_memes',
  'purchases_count_memes_season1',
  'purchases_count_memes_season2',
  'purchases_count_memes_season3',
  'purchases_count_memes_season4',
  'purchases_count_memes_season5',
  'purchases_count_memes_season6',
  'purchases_count_gradients',
  'sales_value_memes',
  'sales_value_memes_season1',
  'sales_value_memes_season2',
  'sales_value_memes_season3',
  'sales_value_memes_season4',
  'sales_value_memes_season5',
  'sales_value_memes_season6',
  'sales_value_gradients',
  'sales_count_memes',
  'sales_count_memes_season1',
  'sales_count_memes_season2',
  'sales_count_memes_season3',
  'sales_count_memes_season4',
  'sales_count_memes_season5',
  'sales_count_memes_season6',
  'sales_count_gradients',
  'transfers_in',
  'transfers_in_memes',
  'transfers_in_memes_season1',
  'transfers_in_memes_season2',
  'transfers_in_memes_season3',
  'transfers_in_memes_season4',
  'transfers_in_memes_season5',
  'transfers_in_memes_season6',
  'transfers_in_gradients',
  'transfers_out',
  'transfers_out_memes',
  'transfers_out_memes_season1',
  'transfers_out_memes_season2',
  'transfers_out_memes_season3',
  'transfers_out_memes_season4',
  'transfers_out_memes_season5',
  'transfers_out_memes_season6',
  'transfers_out_gradients',
  'memes_cards_sets',
  'memes_cards_sets_szn1',
  'memes_cards_sets_szn2',
  'memes_cards_sets_szn3',
  'memes_cards_sets_szn4',
  'memes_cards_sets_szn5',
  'memes_cards_sets_szn6',
  'memes_cards_sets_minus1',
  'memes_cards_sets_minus2',
  'genesis',
  'unique_memes',
  'unique_memes_szn1',
  'unique_memes_szn2',
  'unique_memes_szn3',
  'unique_memes_szn4',
  'unique_memes_szn5',
  'unique_memes_szn6',
  'day_change',
  'day_change_unboosted'
];

export const TAGS_FILTERS = [
  'memes',
  'memes_set',
  'memes_set_minus1',
  'memes_set_szn1',
  'memes_set_szn2',
  'memes_set_szn3',
  'memes_set_szn4',
  'memes_set_szn5',
  'memes_set_szn6',
  'memes_genesis',
  'gradients'
];

export const TRANSACTION_FILTERS = [
  'sales',
  'purchases',
  'transfers',
  'airdrops',
  'mints',
  'burns'
];

export enum NextGenCollectionStatus {
  LIVE = 'live',
  UPCOMING = 'upcoming',
  COMPLETED = 'completed'
}
