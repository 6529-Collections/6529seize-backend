import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  ANALYTICS_DAILY_TABLE,
  HEALTH_DAILY_TABLE,
  UNIQUES_DAILY_TABLE,
  VITALS_DAILY_TABLE
} from '@/constants';

/**
 * First-party analytics daily counters (C52). One row per UTC day, counter
 * cube and dimension combination. Rows never hold an IP address, user agent,
 * identifier or free text: every dimension is a validated enum, route
 * template, referrer hostname or ISO country code. Kept for 25 months.
 */
@Entity(ANALYTICS_DAILY_TABLE)
@Index('ix_analytics_daily_kind_day', ['kind', 'day'])
export class AnalyticsDailyEntity {
  @PrimaryColumn({ type: 'date' })
  readonly day!: string;

  /** UTC hour for product-event rows; -1 for daily totals. */
  @PrimaryColumn({ type: 'smallint' })
  readonly hour!: number;

  @PrimaryColumn({ type: 'varchar', length: 16 })
  readonly kind!: string;

  /** SHA-256 of the canonical dimension tuple (dimensions are below). */
  @PrimaryColumn({ type: 'char', length: 64 })
  readonly dims_key!: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  readonly name!: string;

  @Column({ type: 'varchar', length: 96, default: '' })
  readonly route!: string;

  @Column({ type: 'varchar', length: 96, default: '' })
  readonly prev_route!: string;

  @Column({ type: 'varchar', length: 32, default: '' })
  readonly page_group!: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  readonly referrer_domain!: string;

  @Column({ type: 'varchar', length: 8, default: '' })
  readonly device!: string;

  @Column({ type: 'varchar', length: 8, default: '' })
  readonly platform!: string;

  @Column({ type: 'varchar', length: 8, default: '' })
  readonly browser!: string;

  /** 1 signed in, 0 signed out, -1 not applicable or unknown. */
  @Column({ type: 'smallint', default: -1 })
  readonly signed_in!: number;

  @Column({ type: 'char', length: 2, default: '' })
  readonly country!: string;

  /** Product-event props as canonical `key=value&key=value`. */
  @Column({ type: 'varchar', length: 512, default: '' })
  readonly props!: string;

  @Column({ type: 'bigint', default: 0 })
  readonly count!: number;
}

/**
 * Web vitals as log-scale histograms (see telemetry-vitals-buckets.ts), so
 * p50/p75/p95 can be read back without storing individual measurements.
 */
@Entity(VITALS_DAILY_TABLE)
export class VitalsDailyEntity {
  @PrimaryColumn({ type: 'date' })
  readonly day!: string;

  @PrimaryColumn({ type: 'varchar', length: 96 })
  readonly route!: string;

  @PrimaryColumn({ type: 'varchar', length: 8 })
  readonly device!: string;

  @PrimaryColumn({ type: 'varchar', length: 8 })
  readonly platform!: string;

  @PrimaryColumn({ type: 'varchar', length: 8 })
  readonly metric!: string;

  @PrimaryColumn({ type: 'smallint' })
  readonly bucket!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly count!: number;
}

/** Client health counters (asset, API, WebSocket, long-task, error counts). */
@Entity(HEALTH_DAILY_TABLE)
export class HealthDailyEntity {
  @PrimaryColumn({ type: 'date' })
  readonly day!: string;

  @PrimaryColumn({ type: 'varchar', length: 96 })
  readonly route!: string;

  @PrimaryColumn({ type: 'varchar', length: 8 })
  readonly platform!: string;

  @PrimaryColumn({ type: 'varchar', length: 16 })
  readonly counter!: string;

  @PrimaryColumn({ type: 'varchar', length: 96 })
  readonly dim!: string;

  @Column({ type: 'bigint', default: 0 })
  readonly count!: number;
}

/**
 * Daily unique and active counts (counts only, no identities):
 * anonymous visitors from the in-memory daily-salted HyperLogLog, and
 * signed-in / active-profile DAU, WAU and MAU from existing backend data.
 */
@Entity(UNIQUES_DAILY_TABLE)
export class UniquesDailyEntity {
  @PrimaryColumn({ type: 'date' })
  readonly day!: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly metric!: string;

  @Column({ type: 'bigint', default: 0 })
  readonly count!: number;

  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly updated_at!: Date | null;
}
