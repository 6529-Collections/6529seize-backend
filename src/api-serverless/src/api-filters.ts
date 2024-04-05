export const DISTRIBUTION_SORT = [
  'phase',
  'card_mint_count',
  'count',
  'wallet_tdh',
  'wallet_balance',
  'wallet_unique_balance'
];

export const NFT_TDH_SORT = [
  'balance',
  'boosted_tdh',
  'tdh__raw',
  'total_balance',
  'total_boosted_tdh',
  'total_tdh__raw'
];

export const REMEMES_SORT = ['created_at'];

export const TRANSACTION_FILTERS = [
  'sales',
  'purchases',
  'transfers',
  'airdrops',
  'mints',
  'burns'
];

export const MEMES_EXTENDED_SORT = [
  'age',
  'edition_size',
  'meme',
  'hodlers',
  'tdh',
  'percent_unique',
  'percent_unique_cleaned',
  'floor_price',
  'market_cap',
  'total_volume_last_24_hours',
  'total_volume_last_7_days',
  'total_volume_last_1_month',
  'total_volume'
];

export enum NextGenCollectionStatus {
  LIVE = 'live',
  UPCOMING = 'upcoming',
  COMPLETED = 'completed'
}
