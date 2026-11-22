import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_CHAIN_RATING_EVENTS_TABLE
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

/**
 * One REP or NIC rating change the identity mirror applied to `ratings`, in
 * the same transaction: what the notifications read now that ratings are set
 * on the chain. The mirror finds changes by comparing a target's ratings on
 * the chain with 6529.io's rows, so it has no transaction id. `source` says
 * how: FEED (following the chain's change feed) or FULL_SYNC (a full pass,
 * including the first one after the import; such a row repairs drift and is
 * not news unless its height is after the import).
 */
@Entity(IDENTITY_CHAIN_RATING_EVENTS_TABLE)
@Index('identity_chain_rating_events_height_idx', ['height', 'id'])
@Index('identity_chain_rating_events_target_idx', ['target_profile_id', 'id'])
export class IdentityChainRatingEventEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  /**
   * The chain height of the change: the rating's last set height, or for a
   * removed rating the height the mirror read the target's ratings at.
   */
  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  /** Null when the rater is not mapped to a chain identity. */
  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly rater_principal!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly rater_profile_id!: string;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly target_principal!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_profile_id!: string;

  /** REP or CIC (6529.io's name for NIC). */
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly matter!: string;

  /** The REP category; CIC for NIC. */
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly matter_category!: string;

  /** 0: there was no rating. */
  @Column({ type: 'int', nullable: false })
  readonly old_rating!: number;

  /** 0: the rating was removed. */
  @Column({ type: 'int', nullable: false })
  readonly new_rating!: number;

  /** The target's total in this matter and category after the change. */
  @Column({ type: 'bigint', nullable: false })
  readonly total_after!: number;

  /** FEED or FULL_SYNC. */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly source!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
