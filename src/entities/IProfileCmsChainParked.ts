import { PROFILE_CMS_CHAIN_PARKED_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A Profile change the profile site index could not apply yet, and the same
 * person's later changes queued behind it. The index retries them on every
 * pass while it reads the feed on past them. An index of the chain: a
 * rebuild from empty refills it from the change feed.
 */
@Entity(PROFILE_CMS_CHAIN_PARKED_TABLE)
export class ProfileCmsChainParkedEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly principal!: string;

  @PrimaryColumn({ type: 'int' })
  readonly version!: number;

  @Column({ type: 'bigint' })
  readonly height!: number;

  /** The block time. */
  @Column({ type: 'bigint' })
  readonly time_ms!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly doc_cid!: string | null;

  /** `import` or `operation` when the feed said who wrote it. */
  @Column({ type: 'varchar', length: 20, nullable: true, default: null })
  readonly source!: string | null;

  /** How many of its tries the change has used. */
  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;

  /** Why the last try waited; null for a change queued behind another. */
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly reason!: string | null;

  /** When the index parked it (wall clock). */
  @Column({ type: 'bigint' })
  readonly parked_at!: number;

  /** When the index raised an alert for its long wait, if it did. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly alerted_at!: number | null;
}
