import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';
import {
  IDENTITY_CHAIN_FIRST_BINDINGS_TABLE,
  IDENTITY_CHAIN_FOUNDER_WAITS_TABLE,
  IDENTITY_CHAIN_MIRROR_STATE_TABLE,
  IDENTITY_CHAIN_PLACEHOLDERS_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  IDENTITY_CHAIN_RATING_CATEGORIES_TABLE,
  IDENTITY_CHAIN_RATING_EVENTS_TABLE,
  IDENTITY_CHAIN_RATING_LEDGER_TABLE,
  IDENTITY_CHAIN_REGROUPS_TABLE,
  IDENTITY_CHAIN_WALLETS_TABLE
} from '@/constants';

/**
 * A 6529 chain identity (principal) and the 6529.io profile id its rows use:
 * the imported profile's own id; for an identity made on the chain, its
 * founding wallet's placeholder profile, else an id derived from the
 * principal id. Rebuilt from the chain like the rows it maps.
 */
@Entity(IDENTITY_CHAIN_PRINCIPALS_TABLE)
export class IdentityChainPrincipalEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Index('identity_chain_principals_profile_id_idx', { unique: true })
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly profile_id!: string;

  /**
   * LEGACY (an imported identity's profile), FOUNDER (the placeholder
   * profile of the wallet that made it on the chain), NEW (derived from the
   * principal id).
   */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  /**
   * The chain height of the identity's last level_raw write (feed, full
   * sync or level sweep): no older level is written over it.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly level_height!: number | null;
}

/**
 * An identity made on the chain whose founding wallet's first binding no
 * history could tell yet: since when. Past a bounded wait it is mapped to
 * its derived id; until then it is tried again.
 */
@Entity(IDENTITY_CHAIN_FOUNDER_WAITS_TABLE)
export class IdentityChainFounderWaitEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly since!: number;

  /**
   * The profile id decided for an identity that is filed without a mapping
   * (merged or closed): kept, so it is filed under one id only.
   */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly profile_id!: string | null;
}

/**
 * A wallet bound to a chain identity, from the chain's AddressBinding
 * records: its principal, and the height it has been bound to that
 * principal since without a break. A wallet that is not bound has no row.
 */
@Entity(IDENTITY_CHAIN_WALLETS_TABLE)
@Index('identity_chain_wallets_principal_idx', ['principal_id'])
export class IdentityChainWalletEntity {
  @PrimaryColumn({ type: 'varchar', length: 42, nullable: false })
  readonly wallet!: string;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly bound_from_height!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * 6529.io's placeholder profiles (handle `id-<wallet>`) that no chain
 * identity held, listed once before the mirror's first write. An identity
 * made on the chain takes its founding wallet's. 6529.io makes no
 * placeholder profiles from switch-on and the list never changes, so a
 * rebuild gives the same profile ids.
 */
@Entity(IDENTITY_CHAIN_PLACEHOLDERS_TABLE)
export class IdentityChainPlaceholderEntity {
  @PrimaryColumn({ type: 'varchar', length: 42, nullable: false })
  readonly wallet!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly profile_id!: string;
}

/**
 * A wallet's first-ever principal and the height it was bound at, recorded
 * only while the wallet bindings follow the feed without a break from the
 * import's start (bindings_exact), so it is never a guess. A founder's
 * placeholder is given from it.
 */
@Entity(IDENTITY_CHAIN_FIRST_BINDINGS_TABLE)
export class IdentityChainFirstBindingEntity {
  @PrimaryColumn({ type: 'varchar', length: 42, nullable: false })
  readonly wallet!: string;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;
}

/**
 * A wallet whose consolidation key the mirror changed, written in the same
 * transaction, until the delegations loop has re-keyed TDH, owners,
 * balances, activity and subscriptions for it (so a run cut short loses
 * none).
 */
@Entity(IDENTITY_CHAIN_REGROUPS_TABLE)
export class IdentityChainRegroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 42, nullable: false })
  readonly wallet!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly queued_at!: number;

  /**
   * When a re-keying batch took it up; still set on the next run, the
   * batch didn't finish (the next one is smaller).
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly started_at!: number | null;
}

/**
 * Each identity rating on the chain, as the rating events follower read it
 * from the feed's Rating records (keyed by the record's own key fields):
 * its value and the height it was set at. The events' old values come from
 * here, never from 6529.io's ratings.
 */
@Entity(IDENTITY_CHAIN_RATING_LEDGER_TABLE)
@Index('idx_identity_chain_rating_ledger_total', [
  'target_kind',
  'target_principal',
  'matter',
  'category'
])
export class IdentityChainRatingLedgerEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly rater_principal!: string;

  /** The chain's matter: 1 REP, 2 NIC. */
  @PrimaryColumn({ type: 'int', nullable: false })
  readonly matter!: number;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly target_kind!: number;

  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly target_principal!: string;

  /** The category id (zero for NIC). */
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly category!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly value!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  /**
   * The value can't be trusted (a record the follower couldn't read): the
   * key's next change reads its value before from the chain.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly stale!: boolean;
}

/**
 * The chain's REP category names by id, as the rating events follower read
 * them (a name never changes), so a cold start reads none again.
 */
@Entity(IDENTITY_CHAIN_RATING_CATEGORIES_TABLE)
export class IdentityChainRatingCategoryEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly category_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly name!: string;
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

  /** The phase's list cursor (principal id). */
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly sync_after!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_full_sync_at!: number | null;

  /**
   * The next feed height the wallet bindings (identity_chain_wallets) read:
   * they are exact through the height before it. Null before they start.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly bindings_next_height!: number | null;

  /**
   * The network id of the chain the mirror read: on another one (a
   * relaunch) the bindings and the identity tables start again.
   */
  @Column({ type: 'varchar', length: 80, nullable: true, default: null })
  readonly chain_id!: string | null;

  /** When the placeholder profiles were listed (once, before any write). */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly placeholders_at!: number | null;

  /**
   * The wallet bindings have followed the feed without a break from the
   * import's start (no membership list since): their first bindings are
   * exact.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly bindings_exact!: boolean;

  /** The latest TDH day seen on the chain's levels. */
  @Column({ type: 'int', nullable: true, default: null })
  readonly levels_tdh_day!: number | null;

  /**
   * A level sweep under way after a TDH day (the day it is for), and its
   * place in the chain's level ranking.
   */
  @Column({ type: 'int', nullable: true, default: null })
  readonly level_sweep_day!: number | null;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly level_sweep_after!: string | null;

  /** The chain height the latest TDH day was first seen at. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly levels_day_height!: number | null;

  /** The full sync's delegation phase: the next use case to walk. */
  @Column({ type: 'int', nullable: true, default: null })
  readonly sync_use_case!: number | null;

  /** The rows off the chain's level fix: the last key it got to. */
  @Column({ type: 'varchar', length: 255, nullable: true, default: null })
  readonly off_chain_after!: string | null;

  /** Within that use case, the last wallet written (wallets in order). */
  @Column({ type: 'varchar', length: 42, nullable: true, default: null })
  readonly sync_wallet_after!: string | null;

  /**
   * The highest finalized height the mirror has pinned reads to: no later
   * run pins below it, so none writes older state than one before.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly pin_floor!: number | null;

  /**
   * The next feed height the rating events follower reads (its own column:
   * the rest of the mirror never writes it).
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly events_next_height!: number | null;

  /**
   * A rebuild of the rating ledger under way at this pinned height, after a
   * gap in the feed (null: none); the follower goes on from the next one.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly events_rebuild_height!: number | null;

  /** Where the rebuild's walk over the identities is (null: the start). */
  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly events_rebuild_after!: string | null;

  /** The height the feed was first found gone at; a second run confirms. */
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly events_gone_at!: number | null;

  /** Runs in a row the follower didn't move while behind the identities. */
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly events_stuck_runs!: number;

  /**
   * What the mirror could not write, tried again by the next run (JSON:
   * principals, rating targets and wallets). A full sync starts it again.
   */
  @Column({ type: 'mediumtext', nullable: true, default: null })
  readonly retry_json!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * One rating change on the 6529 chain, from the feed's Rating records: a
 * row per record per block (the feed gives each key's final value in a
 * block, with its last writer), written by the rating events follower with
 * its ledger (identity_chain_rating_ledger) from the import's start. From
 * switch-on the source of REP and NIC notifications; only `origin`
 * OPERATION (a rater's RATING_SET) notifies.
 */
@Entity(IDENTITY_CHAIN_RATING_EVENTS_TABLE)
@Index(
  'uq_identity_chain_rating_events_key',
  [
    'height',
    'rater_principal',
    'target_principal',
    'matter',
    'matter_category'
  ],
  { unique: true }
)
@Index('idx_identity_chain_rating_events_target', [
  'target_profile_id',
  'height'
])
@Index('idx_identity_chain_rating_events_time', ['block_time_ms'])
@Index('idx_identity_chain_rating_events_created', ['created_at'])
export class IdentityChainRatingEventEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  /** The block of the record. */
  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  /** The block's time (its slot start), Unix ms. */
  @Column({ type: 'bigint', nullable: false })
  readonly block_time_ms!: number;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly rater_principal!: string;

  /**
   * The rater's 6529.io profile id when mapped; null when not. The follower
   * maps the rater and target of an OPERATION row itself when it can; a
   * null one is filled in once mapped: any row until the fill has made a
   * whole pass after a first full sync ended, then a row written in the
   * last day. A principal never mapped, merged or closed, can leave it null.
   */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly rater_profile_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly target_principal!: string;

  /** The target's 6529.io profile id when mapped; filled in as the rater's. */
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly target_profile_id!: string | null;

  /** REP or CIC (6529.io's name for NIC). */
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly matter!: string;

  /** The REP category's name; '' for CIC. */
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly matter_category!: string;

  /**
   * The value before (0: none): the ledger's, or the chain's at the height
   * before when the ledger's row can't be trusted.
   */
  @Column({ type: 'bigint', nullable: false })
  readonly old_rating!: number;

  /** 0: the rating was removed. */
  @Column({ type: 'bigint', nullable: false })
  readonly new_rating!: number;

  /**
   * The target's total in this matter and category after the block: its
   * RatingTotal record; without one, the ledger's total plus the change
   * when none of its rows is stale and there was no gap, else the chain's
   * totals at that height.
   */
  @Column({ type: 'bigint', nullable: false })
  readonly total_after!: number;

  /** OPERATION, CAP_CUT, IMPORT or UNKNOWN (ratingEventOrigin). */
  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  /** The record's import marker; 0 when not given. */
  @Column({ type: 'tinyint', width: 1, nullable: false, default: 0 })
  readonly by_import!: number;

  /** The record's last writer as given (tx:<op> or system:<step>). */
  @Column({ type: 'varchar', length: 40, nullable: true, default: null })
  readonly writer!: string | null;

  /** FEED. */
  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly source!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
