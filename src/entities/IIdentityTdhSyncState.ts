import { Column, Entity, PrimaryColumn } from 'typeorm';
import { IDENTITY_TDH_SYNC_STATE_TABLE } from '@/constants/db-tables';

/**
 * Progress of the identities sync that follows each consolidated-TDH write
 * (see identity-tdh-sync.ts). A few fixed rows, one per role, so the TDH
 * transaction's marker lock never blocks the lease or the synced mark:
 *
 * - `pending`: `generation` is bumped and `block` set inside every
 *   consolidated-TDH transaction, so a committed generation means committed
 *   TDH rows.
 * - `synced`: the highest pending generation whose identities sync finished.
 * - `lease`: which invocation is running the sync, and until when.
 * - `metrics_walk`: how far the identities metrics walk (step C) got for
 *   `generation`: the last committed chunk's last key, so a resumed sync
 *   continues after it.
 * - `full_walk`: the last generation whose step C walked every identity, and
 *   when it finished (`updated_at`), for the daily full reconciliation.
 *
 * `ratings_since` (database clock, epoch seconds) bounds which ratings a
 * scoped step C rechecks. On `metrics_walk` it is the walk's start minus the
 * longest rating transaction; on `synced` it is that value from the last
 * finished sync, and 0 until a sync has set it.
 */
@Entity(IDENTITY_TDH_SYNC_STATE_TABLE)
export class IdentityTdhSyncStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly id!: string;

  @Column({ type: 'bigint', default: 0 })
  readonly generation!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly block!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly lease_owner!: string | null;

  @Column({ type: 'bigint', default: 0 })
  readonly lease_until!: number;

  /** Same type as identities.consolidation_key. */
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly walk_after!: string | null;

  @Column({ type: 'bigint', default: 0 })
  readonly ratings_since!: number;

  @Column({ type: 'bigint', default: 0 })
  readonly updated_at!: number;
}
