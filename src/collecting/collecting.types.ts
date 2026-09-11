/** Internal domain contracts. Public responses are mapped to OpenAPI-generated models. */
export type CollectingFamily = 'memes' | 'gradients' | 'pebbles';
export type PebblesTrait = 'Palette' | 'Size' | 'Traced';
export type CollectingGoalKind =
  | 'memes_season'
  | 'memes_full_set'
  | 'memes_artist'
  | 'gradients_full_set'
  | 'pebbles_trait_set'
  | 'pebbles_ultimate'
  | 'exact';

export interface CollectingAsset {
  asset_key: string;
  chain_id: number;
  contract: string;
  token_id: string;
  family: CollectingFamily;
  name: string;
  image_url: string | null;
  artist_ids: string[];
  season: number | null;
  traits: Array<{ trait: string; value: string }>;
  /** Indexed base accrual rate, not a projected or executable financial return. */
  hodl_rate: number | null;
  tdh_eligible: boolean;
}

export interface CollectingCatalog {
  version: string;
  chain_id: number;
  assets: CollectingAsset[];
  seasons: Array<{
    id: number;
    name: string;
    asset_keys: string[];
    current: boolean;
  }>;
  artists: Array<{
    id: string;
    name: string;
    asset_keys: string[];
    collaboration_asset_keys: string[];
  }>;
  pebbles_traits: Array<{ trait: PebblesTrait; values: string[] }>;
  tdh_snapshot: { block_number: number; block_timestamp: string } | null;
}

export interface CollectingAccount {
  profile_id: string;
  consolidation_key: string;
  wallets: string[];
  membership_hash: string;
}

export interface CollectingHolding {
  asset_key: string;
  wallet: string;
  quantity: string;
}

export interface CollectingAnalysisRequest {
  profile_id: string;
  kind: CollectingGoalKind;
  catalog_version?: string;
  season_id?: number;
  artist_id?: string;
  include_collaborations?: boolean;
  trait?: PebblesTrait;
  target_copies?: string;
  universe?: 'released' | 'tdh_eligible';
  assets?: Array<{ asset_key: string; quantity: string }>;
  recipient?: string;
}

export interface CollectingRequirement {
  id: string;
  label: string;
  target_quantity: string;
  owned_quantity: string;
  missing_quantity: string;
  asset_keys: string[];
  holdings: CollectingHolding[];
}

export interface CollectingAnalysis {
  analysis_id: string;
  catalog_version: string;
  account: CollectingAccount;
  holdings_snapshot: {
    block_number: number;
    nextgen_block_number: number | null;
  };
  kind: CollectingGoalKind;
  target_copies: string;
  requirements: CollectingRequirement[];
  required_count: number;
  satisfied_count: number;
  complete: boolean;
  missing_asset_keys: string[];
  recipient: string | null;
  recipient_in_profile: boolean;
  counts_toward_profile: boolean;
}

export interface CollectingAssetSearch {
  family?: CollectingFamily;
  query?: string;
  page: number;
  page_size: number;
}
