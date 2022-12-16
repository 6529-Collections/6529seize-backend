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
