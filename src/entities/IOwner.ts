export interface Owner {
  created_at: Date;
  wallet: string;
  token_id: number;
  contract: string;
  balance: number;
}

export interface OwnerTags {
  created_at: Date;
  wallet: string;
  memes_balance: number;
  unique_memes: number;
  gradients_balance: number;
  genesis: number;
  nakamoto: number;
  memes_cards_sets: number;
  memes_cards_sets_minus1: number;
  memes_cards_sets_minus2: number;
  memes_cards_sets_szn1: number;
  memes_cards_sets_szn2: number;
}

export interface OwnerMetric {
  created_at: Date;
  wallet: string;
  balance: number;
  memes_balance: number;
  memes_balance_season1: number;
  memes_balance_season2: number;
  gradients_balance: number;
  purchases_value: number;
  purchases_count: number;
  purchases_value_memes: number;
  purchases_count_memes: number;
  purchases_value_memes_season1: number;
  purchases_count_memes_season1: number;
  purchases_value_memes_season2: number;
  purchases_count_memes_season2: number;
  purchases_value_gradients: number;
  purchases_count_gradients: number;
  purchases_value_primary: number;
  purchases_count_primary: number;
  purchases_value_primary_memes: number;
  purchases_count_primary_memes: number;
  purchases_value_primary_memes_season1: number;
  purchases_count_primary_memes_season1: number;
  purchases_value_primary_memes_season2: number;
  purchases_count_primary_memes_season2: number;
  purchases_value_primary_gradients: number;
  purchases_count_primary_gradients: number;
  purchases_value_secondary: number;
  purchases_count_secondary: number;
  purchases_value_secondary_memes: number;
  purchases_count_secondary_memes: number;
  purchases_value_secondary_memes_season1: number;
  purchases_count_secondary_memes_season1: number;
  purchases_value_secondary_memes_season2: number;
  purchases_count_secondary_memes_season2: number;
  purchases_value_secondary_gradients: number;
  purchases_count_secondary_gradients: number;
  sales_value: number;
  sales_count: number;
  sales_value_memes: number;
  sales_count_memes: number;
  sales_value_memes_season1: number;
  sales_count_memes_season1: number;
  sales_value_memes_season2: number;
  sales_count_memes_season2: number;
  sales_value_gradients: number;
  sales_count_gradients: number;
  transfers_in: number;
  transfers_in_memes: number;
  transfers_in_memes_season1: number;
  transfers_in_memes_season2: number;
  transfers_in_gradients: number;
  transfers_out: number;
  transfers_out_memes: number;
  transfers_out_memes_season1: number;
  transfers_out_memes_season2: number;
  transfers_out_gradients: number;
}
