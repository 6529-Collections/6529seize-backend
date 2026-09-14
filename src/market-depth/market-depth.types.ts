export const MARKET_DEPTH_CHAIN = 'ethereum' as const;
export const MARKET_DEPTH_CHAIN_ID = '1' as const;
export const MAX_MARKET_DEPTH_COLLECTION_ASKS = 10000;
export const MAX_MARKET_DEPTH_COLLECTION_PARTITIONS = 8;

export const MARKET_DEPTH_SNAPSHOT_SCHEMA_VERSION = 1;
/**
 * Snapshot archives share one SQL packet and the current driver hex-escapes
 * buffers. Keep escaped payloads below a conservative 16 MiB packet budget,
 * with headroom for SQL and snapshot metadata; remote packet settings vary.
 */
export const MAX_MARKET_DEPTH_ARCHIVE_BYTES = 4 * 1024 * 1024;
export const MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES = 6 * 1024 * 1024;

export type MarketDepthOrderSide = 'ask' | 'bid';
export type MarketDepthOrderStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'FULFILLED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'UNKNOWN';
export type MarketDepthOrderScope =
  | 'token'
  | 'collection'
  | 'trait'
  | 'unknown';

export type MarketDepthJsonValue =
  | string
  | number
  | boolean
  | null
  | MarketDepthJsonValue[]
  | { [key: string]: MarketDepthJsonValue };

export interface NormalizedMarketDepthOrder {
  /** Deterministic, bounded hash key derived from protocol/source/order identity. */
  order_key: string;
  order_id: string;
  source: string;
  protocol: string;
  contract: string;
  collection_slug: string;
  token_id: string | null;
  side: MarketDepthOrderSide;
  status: MarketDepthOrderStatus;
  is_private: boolean;
  scope: MarketDepthOrderScope;
  maker: string | null;
  original_quantity: string;
  remaining_quantity: string;
  currency_contract: string | null;
  currency_symbol: string | null;
  currency_decimals: number | null;
  current_price_raw: string | null;
  current_price_decimal: string | null;
  unit_price_decimal: string | null;
  start_at: Date | null;
  end_at: Date | null;
  observed_at: Date;
  source_url: string | null;
  criteria: MarketDepthJsonValue | null;
  protocol_data: MarketDepthJsonValue | null;
  source_data: MarketDepthJsonValue | null;
  is_executable: boolean | null;
  executable_caveats: MarketDepthJsonValue | null;
}

export interface PublishMarketDepthSnapshotInput {
  id: string;
  contract: string;
  collection_slug: string;
  collection_id?: number | null;
  source: string;
  started_at: Date;
  completed_at: Date;
  normalizer_version: string;
  raw_order_count: number;
  unsupported_count: number;
  skipped_count: number;
  event_count: number;
  raw_archive_gzip: Buffer;
  normalized_archive_gzip: Buffer;
  orders: NormalizedMarketDepthOrder[];
  /** Missing orders to durably queue in the same transaction as publication. */
  reconciliations?: MarketDepthReconciliationInput[];
}

export interface MarketDepthSnapshotMetadata {
  id: string;
  chain: typeof MARKET_DEPTH_CHAIN;
  chain_id: typeof MARKET_DEPTH_CHAIN_ID;
  contract: string;
  collection_slug: string;
  collection_id: number | null;
  source: string;
  schema_version: number;
  normalizer_version: string;
  started_at: Date;
  completed_at: Date;
  raw_order_count: number;
  order_count: number;
  ask_count: number;
  bid_count: number;
  unsupported_count: number;
  skipped_count: number;
  event_count: number;
}

export interface CurrentMarketDepthOrder extends NormalizedMarketDepthOrder {
  snapshot_id: string;
  chain: typeof MARKET_DEPTH_CHAIN;
  chain_id: typeof MARKET_DEPTH_CHAIN_ID;
}

export interface CurrentMarketDepthSnapshot {
  snapshot: MarketDepthSnapshotMetadata;
  orders: CurrentMarketDepthOrder[];
}

export interface MarketDepthSnapshotReadOptions {
  /** Include this token's orders plus collection/criteria orders with no token. */
  token_id?: string;
  /** Large provider/protocol payloads are retained in DB but can be omitted. */
  include_payloads?: boolean;
  /** Bound collection-wide discovery without reading the much larger bid book. */
  side?: MarketDepthOrderSide;
  limit?: number;
}

export interface MarketDepthSnapshotArchive {
  snapshot_id: string;
  raw_archive_gzip: Buffer;
  normalized_archive_gzip: Buffer;
}

export interface MarketDepthEventInput {
  event_id: string;
  kind: string;
  source: string;
  source_evidence: string | null;
  provider_at: Date | null;
  observed_at: Date;
  order_id: string | null;
  contract: string;
  collection_slug: string;
  token_id: string | null;
  maker: string | null;
  taker: string | null;
  quantity: string | null;
  currency_contract: string | null;
  currency_symbol: string | null;
  currency_decimals: number | null;
  price_raw: string | null;
  price_decimal: string | null;
  transaction_hash: string | null;
  raw: MarketDepthJsonValue;
}

export interface AppendMarketDepthEventsInput {
  source: string;
  contract: string;
  collection_slug: string;
  expected_cursor: string | null;
  expected_watermark: string | null;
  next_cursor: string | null;
  provider_watermark: string | null;
  provider_at: Date | null;
  observed_at: Date;
  events: MarketDepthEventInput[];
}

export interface MarketDepthCursor {
  source: string;
  chain: typeof MARKET_DEPTH_CHAIN;
  chain_id: typeof MARKET_DEPTH_CHAIN_ID;
  contract: string;
  collection_slug: string;
  provider_cursor: string | null;
  provider_watermark: string | null;
  provider_at: Date | null;
  observed_at: Date;
}

export type MarketDepthReconciliationStatus = 'PENDING' | 'RESOLVED';

export interface MarketDepthReconciliationInput {
  prior_snapshot_id: string;
  source: string;
  contract: string;
  collection_slug: string;
  missing_at: Date;
  order: NormalizedMarketDepthOrder;
}

export interface MarketDepthReconciliation {
  id: string;
  prior_snapshot_id: string;
  source: string;
  chain: typeof MARKET_DEPTH_CHAIN;
  chain_id: typeof MARKET_DEPTH_CHAIN_ID;
  contract: string;
  collection_slug: string;
  protocol: string;
  order_id: string;
  order_key: string;
  token_id: string | null;
  side: MarketDepthOrderSide;
  prior_order: NormalizedMarketDepthOrder;
  status: MarketDepthReconciliationStatus;
  first_missing_at: Date;
  next_attempt_at: Date;
  last_attempt_at: Date | null;
  attempt_count: number;
  resolved_at: Date | null;
  last_error: string | null;
}

export interface MarketDepthReconciliationRetryInput {
  id: string;
  expected_attempt_count: number;
  attempted_at: Date;
  next_attempt_at: Date;
  last_error: string;
}

export interface MarketDepthReconciliationResolveInput {
  id: string;
  expected_attempt_count: number;
  resolved_at: Date;
}
