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
  genesis: boolean;
  memes_cards_sets: number;
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
  purchases_value_primary: number;
  purchases_count_primary: number;
  purchases_value_secondary: number;
  purchases_count_secondary: number;
  sales_value: number;
  sales_count: number;
  transfers_in: number;
  transfers_out: number;
}
