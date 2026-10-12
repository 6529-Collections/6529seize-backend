import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE } from '@/constants';

@Entity(SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE)
@Index(`${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}_due_idx`, [
  'parked',
  'next_attempt_at'
])
export class SubscriptionCacheInvalidationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'json' })
  readonly consolidation_keys!: string[];

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly next_attempt_at!: number;

  @Column({ type: 'varchar', length: 20, default: '0' })
  readonly scan_cursor!: string;

  @Column({ type: 'boolean', default: false })
  readonly parked!: boolean;

  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true })
  readonly last_error!: string | null;
}
