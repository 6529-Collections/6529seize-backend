import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE
} from '@/constants';

/**
 * A 6529 chain identity (principal) and the 6529.io profile id its rows use:
 * the imported profile's own id, or one derived from the principal id for an
 * identity made on the chain. Rebuilt from the chain like the rows it maps.
 */
@Entity(IDENTITY_CHAIN_PRINCIPALS_TABLE)
export class IdentityChainPrincipalEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Index('identity_chain_principals_profile_id_idx', { unique: true })
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly profile_id!: string;

  /** LEGACY (imported profile), WALLET (a wallet's existing profile), NEW. */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

/** One row (id 'identity'): the mirror's place in the change feed. */
@Entity(IDENTITY_CHAIN_MIRROR_STATE_TABLE)
export class IdentityChainMirrorStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 20, nullable: false })
  readonly id!: string;

  /** The next finalized height to read from the feed; null before a sync. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly next_height!: number | null;

  /** A full sync under way: the height it started at. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly sync_from_height!: number | null;

  /** IDENTITIES, DELEGATIONS or CONSOLIDATIONS while a full sync runs. */
  @Column({ type: 'varchar', length: 20, nullable: true, default: null })
  readonly sync_phase!: string | null;

  /** The phase's list cursor (principal id, use case). */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly sync_after!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_full_sync_at!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
