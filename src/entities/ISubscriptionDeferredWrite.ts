import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SUBSCRIPTION_DEFERRED_WRITES_TABLE } from '@/constants';

/**
 * A subscription write held back because its consolidation key is longer
 * than a table's key column. The key is kept as text, so any key fits here;
 * the payload holds everything needed to make the write later.
 */
@Entity(SUBSCRIPTION_DEFERRED_WRITES_TABLE)
@Index('idx_subscription_deferred_writes_pending', [
  'replayed_at',
  'created_at'
])
export class SubscriptionDeferredWriteEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 32 })
  readonly kind!: string;

  @Column({ type: 'text' })
  readonly consolidation_key!: string;

  @Column({ type: 'int' })
  readonly key_length!: number;

  @Column({ type: 'json' })
  readonly payload!: unknown;

  @Column({ type: 'text' })
  readonly reason!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly replayed_at!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  readonly outcome!: string | null;
}
