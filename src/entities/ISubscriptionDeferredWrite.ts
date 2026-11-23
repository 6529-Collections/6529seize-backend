import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SUBSCRIPTION_DEFERRED_WRITES_TABLE } from '@/constants';

/**
 * A subscription write held back because its consolidation key does not fit
 * every subscription table's key column, or because an earlier write for the
 * same key is still held back. The key is kept as text, so any key fits
 * here; the payload holds everything needed to make the write later.
 * `sequence` orders the writes; `dedupe_key` keeps one entry per write.
 */
@Entity(SUBSCRIPTION_DEFERRED_WRITES_TABLE)
@Index('idx_subscription_deferred_writes_key', ['key_hash', 'replayed_at'])
@Index('idx_subscription_deferred_writes_pending', ['replayed_at', 'sequence'])
export class SubscriptionDeferredWriteEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly sequence!: number;

  @Column({ type: 'varchar', length: 32 })
  readonly kind!: string;

  @Column({ type: 'text' })
  readonly consolidation_key!: string;

  /** sha256 of the key, hex; the key itself is too long to index. */
  @Column({ type: 'varchar', length: 64 })
  readonly key_hash!: string;

  @Column({ type: 'int' })
  readonly key_length!: number;

  /** sha256 of what makes the write unique, hex. */
  @Index('uq_subscription_deferred_writes_dedupe', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  readonly dedupe_key!: string;

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
