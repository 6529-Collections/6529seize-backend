import { Column, Entity, PrimaryColumn } from 'typeorm';
import { SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE } from '@/constants';

/**
 * The re-key fallback's run state (one row): when it last ran, and the
 * keys it found stale, each with how many runs in a row it has been stale.
 * Ephemeral: without the row the next run starts over, seeing every stale
 * key for the first time.
 */
@Entity(SUBSCRIPTION_REKEY_FALLBACK_STATE_TABLE)
export class SubscriptionRekeyFallbackStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly id!: string;

  /** Milliseconds. */
  @Column({ type: 'bigint' })
  readonly last_run_at!: number;

  /** Each stale key and the runs in a row it has been stale. */
  @Column({ type: 'json' })
  readonly stale_runs!: Record<string, number>;
}
