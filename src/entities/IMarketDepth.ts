import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import {
  MARKET_DEPTH_CHAIN,
  MARKET_DEPTH_CHAIN_ID,
  MarketDepthJsonValue,
  MarketDepthOrderScope,
  MarketDepthOrderSide,
  MarketDepthOrderStatus,
  MarketDepthReconciliationStatus,
  NormalizedMarketDepthOrder
} from '@/market-depth/market-depth.types';
import {
  MARKET_DEPTH_COLLECTION_STATE_TABLE,
  MARKET_DEPTH_CURRENT_ORDERS_TABLE,
  MARKET_DEPTH_CURSORS_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE,
  MARKET_DEPTH_SNAPSHOTS_TABLE
} from '@/constants/db-tables';

@Entity(MARKET_DEPTH_SNAPSHOTS_TABLE)
@Index('idx_market_depth_snapshots_collection_completed', [
  'source',
  'chain_id',
  'contract',
  'collection_slug',
  'completed_at'
])
export class MarketDepthSnapshotEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN })
  chain!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN_ID })
  chain_id!: string;

  @Column({ type: 'varchar', length: 64 })
  contract!: string;

  @Column({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'int', unsigned: true, nullable: true })
  collection_id!: number | null;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'int', unsigned: true })
  schema_version!: number;

  @Column({ type: 'varchar', length: 100 })
  normalizer_version!: string;

  @Column({ type: 'datetime', precision: 3 })
  started_at!: Date;

  @Column({ type: 'datetime', precision: 3 })
  completed_at!: Date;

  @Column({ type: 'int', unsigned: true })
  raw_order_count!: number;

  @Column({ type: 'int', unsigned: true })
  order_count!: number;

  @Column({ type: 'int', unsigned: true })
  ask_count!: number;

  @Column({ type: 'int', unsigned: true })
  bid_count!: number;

  @Column({ type: 'int', unsigned: true })
  unsupported_count!: number;

  @Column({ type: 'int', unsigned: true })
  skipped_count!: number;

  @Column({ type: 'int', unsigned: true })
  event_count!: number;

  @Column({ type: 'longblob' })
  raw_archive_gzip!: Buffer;

  @Column({ type: 'longblob' })
  normalized_archive_gzip!: Buffer;
}

@Entity(MARKET_DEPTH_COLLECTION_STATE_TABLE)
export class MarketDepthCollectionStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  source!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 32,
    default: MARKET_DEPTH_CHAIN_ID
  })
  chain_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'int', unsigned: true, nullable: true })
  collection_id!: number | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  latest_snapshot_id!: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  latest_started_at!: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  latest_completed_at!: Date | null;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at!: Date;
}

@Entity(MARKET_DEPTH_CURRENT_ORDERS_TABLE)
@Index('idx_market_depth_current_orders_snapshot_token', [
  'snapshot_id',
  'token_id'
])
@Index('idx_market_depth_current_orders_lookup', [
  'chain_id',
  'contract',
  'collection_slug',
  'side',
  'scope',
  'token_id'
])
@Index('idx_market_depth_current_orders_available', [
  'chain_id',
  'contract',
  'collection_slug',
  'status',
  'is_private',
  'end_at'
])
@Index(
  'uq_market_depth_current_orders_provider_order',
  ['chain_id', 'contract', 'collection_slug', 'source', 'protocol', 'order_id'],
  { unique: true }
)
export class MarketDepthCurrentOrderEntity {
  @PrimaryColumn({ type: 'varchar', length: 191 })
  order_key!: string;

  @Column({ type: 'varchar', length: 36 })
  snapshot_id!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN })
  chain!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN_ID })
  chain_id!: string;

  @Column({ type: 'varchar', length: 191 })
  order_id!: string;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'varchar', length: 64 })
  protocol!: string;

  @Column({ type: 'varchar', length: 64 })
  contract!: string;

  @Column({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  token_id!: string | null;

  @Column({ type: 'varchar', length: 8 })
  side!: MarketDepthOrderSide;

  @Column({ type: 'varchar', length: 16 })
  status!: MarketDepthOrderStatus;

  @Column({ type: 'boolean' })
  is_private!: boolean;

  @Column({ type: 'varchar', length: 16 })
  scope!: MarketDepthOrderScope;

  @Column({ type: 'varchar', length: 64, nullable: true })
  maker!: string | null;

  @Column({ type: 'varchar', length: 100 })
  original_quantity!: string;

  @Column({ type: 'varchar', length: 100 })
  remaining_quantity!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  currency_contract!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  currency_symbol!: string | null;

  @Column({ type: 'smallint', unsigned: true, nullable: true })
  currency_decimals!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  current_price_raw!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  current_price_decimal!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  unit_price_decimal!: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  start_at!: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  end_at!: Date | null;

  @Column({ type: 'datetime', precision: 3 })
  observed_at!: Date;

  @Column({ type: 'text', nullable: true })
  source_url!: string | null;

  @Column({ type: 'json', nullable: true })
  criteria!: MarketDepthJsonValue | null;

  @Column({ type: 'json', nullable: true })
  protocol_data!: MarketDepthJsonValue | null;

  @Column({ type: 'json', nullable: true })
  source_data!: MarketDepthJsonValue | null;

  @Column({ type: 'boolean', nullable: true })
  is_executable!: boolean | null;

  @Column({ type: 'json', nullable: true })
  executable_caveats!: MarketDepthJsonValue | null;
}

@Entity(MARKET_DEPTH_EVENTS_TABLE)
@Index('idx_market_depth_events_collection_time', [
  'chain_id',
  'contract',
  'collection_slug',
  'provider_at'
])
@Index('idx_market_depth_events_order', ['source', 'order_id'])
@Index('idx_market_depth_events_occurred', ['occurred_at', 'event_id'])
@Index('idx_market_depth_events_token_occurred', [
  'chain_id',
  'contract',
  'token_id',
  'occurred_at',
  'event_id'
])
@Index('idx_market_depth_events_contract_observed', [
  'chain_id',
  'contract',
  'observed_at'
])
export class MarketDepthEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 191 })
  event_id!: string;

  @Column({ type: 'varchar', length: 64 })
  kind!: string;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'text', nullable: true })
  source_evidence!: string | null;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN })
  chain!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN_ID })
  chain_id!: string;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  provider_at!: Date | null;

  @Column({ type: 'datetime', precision: 3 })
  observed_at!: Date;

  @Column({
    type: 'datetime',
    precision: 3,
    insert: false,
    update: false,
    generatedType: 'STORED',
    asExpression: 'COALESCE(provider_at, observed_at)'
  })
  occurred_at!: Date;

  @Column({ type: 'varchar', length: 191, nullable: true })
  order_id!: string | null;

  @Column({ type: 'varchar', length: 64 })
  contract!: string;

  @Column({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  token_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  maker!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  taker!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  quantity!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  currency_contract!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  currency_symbol!: string | null;

  @Column({ type: 'smallint', unsigned: true, nullable: true })
  currency_decimals!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  price_raw!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  price_decimal!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  transaction_hash!: string | null;

  @Column({ type: 'json' })
  raw!: MarketDepthJsonValue;
}

@Entity(MARKET_DEPTH_CURSORS_TABLE)
export class MarketDepthCursorEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  source!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 32,
    default: MARKET_DEPTH_CHAIN_ID
  })
  chain_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  contract!: string;

  @PrimaryColumn({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  provider_cursor!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  provider_watermark!: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  provider_at!: Date | null;

  @Column({ type: 'datetime', precision: 3 })
  observed_at!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at!: Date;
}

@Entity(MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE)
@Index('idx_market_depth_reconciliation_due', [
  'source',
  'chain_id',
  'contract',
  'collection_slug',
  'status',
  'next_attempt_at'
])
@Index('idx_market_depth_reconciliation_order', [
  'source',
  'protocol',
  'order_id'
])
export class MarketDepthReconciliationEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  prior_snapshot_id!: string;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN })
  chain!: string;

  @Column({ type: 'varchar', length: 32, default: MARKET_DEPTH_CHAIN_ID })
  chain_id!: string;

  @Column({ type: 'varchar', length: 64 })
  contract!: string;

  @Column({ type: 'varchar', length: 190 })
  collection_slug!: string;

  @Column({ type: 'varchar', length: 64 })
  protocol!: string;

  @Column({ type: 'varchar', length: 191 })
  order_id!: string;

  @Column({ type: 'varchar', length: 191 })
  order_key!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  token_id!: string | null;

  @Column({ type: 'varchar', length: 8 })
  side!: MarketDepthOrderSide;

  @Column({ type: 'json' })
  prior_order!: NormalizedMarketDepthOrder;

  @Column({ type: 'varchar', length: 16 })
  status!: MarketDepthReconciliationStatus;

  @Column({ type: 'datetime', precision: 3 })
  first_missing_at!: Date;

  @Column({ type: 'datetime', precision: 3 })
  next_attempt_at!: Date;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  last_attempt_at!: Date | null;

  @Column({ type: 'int', unsigned: true, default: 0 })
  attempt_count!: number;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  resolved_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at!: Date;
}
