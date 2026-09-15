/** Saved rules only prepare reviews. Every transaction still requires wallet approval. */
export interface CollectingRuleDefinition {
  profile_id: string;
  funding_wallet: string;
  recipient: string;
  plan_id: string | null;
  analysis_id: string | null;
  targets: Array<{
    asset_key: string;
    target_quantity: string;
    maximum_unit_price_wei: string;
  }>;
  /** Native ETH purchase costs plus actual gas across this rule's lifetime. */
  max_total_cost_wei: string;
  /** Maximum gas reserve for any single review, not an on-chain spending limit. */
  max_gas_reserve_wei: string;
  expires_at: number;
  max_actions: number;
}

export interface CollectingRuleReview {
  operation_id: string;
  quote_id: string;
  profile_id: string;
  funding_wallet: string;
  recipient: string;
  valid_until: number;
  assets: Array<{
    asset_key: string;
    quantity: string;
    unit_price_wei: string;
  }>;
  item_cost_wei: string;
  gas_reserve_wei: string;
}

/** Constructed only from a verified terminal operation/receipt on the server. */
export interface CollectingRuleSettlement {
  operation_id: string;
  status: 'confirmed' | 'reverted' | 'cancelled' | 'expired';
  transaction_hash: string | null;
  recipient: string;
  assets: Array<{ asset_key: string; quantity: string }>;
  item_cost_wei: string;
  gas_cost_wei: string;
}

export interface CollectingRule {
  id: string;
  mode: 'prepare_for_approval';
  definition: CollectingRuleDefinition;
  revision: number;
  state: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'EXPIRED';
  pause_reason: string | null;
  acquired: Array<{ asset_key: string; quantity: string }>;
  spent_item_cost_wei: string;
  spent_gas_cost_wei: string;
  action_count: number;
  review_count: number;
  pending_review: CollectingRuleReview | null;
  created_at: number;
  updated_at: number;
}
