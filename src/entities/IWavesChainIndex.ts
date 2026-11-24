import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CHAIN_DECISION_LEADERBOARDS_TABLE,
  CHAIN_DECISIONS_TABLE,
  CHAIN_ENTRIES_TABLE,
  CHAIN_GROUPS_TABLE,
  CHAIN_LEADERBOARD_ROWS_TABLE,
  CHAIN_POLLS_TABLE,
  CHAIN_RESULTS_TABLE,
  CHAIN_VOTES_TABLE,
  CHAIN_WAVE_REP_TABLE,
  CHAIN_WAVE_ROLES_TABLE,
  CHAIN_WAVES_TABLE,
  WAVES_CHAIN_INDEX_STATE_TABLE
} from '@/constants';

/**
 * 6529.io's index of the 6529 chain's waves, groups, roles, decisions,
 * entries, votes, results, polls and wave REP (src/waves-chain-index). It is
 * no source of truth: every row is the chain's answer at `height`, rebuilt
 * from the chain's API and its change feed, and a rebuild from empty gives
 * the same rows. `data` holds the API's whole object; the columns beside it
 * are what 6529.io's reads filter and sort by. `generation` is the full
 * read that last saw the row: a full read removes rows it didn't see.
 * DECIMAL columns are there to sort and compare by; the driver reads them
 * as JavaScript numbers, so read the exact value as `cast(col as char)` or
 * from `data`.
 */

@Entity(WAVES_CHAIN_INDEX_STATE_TABLE)
export class WavesChainIndexStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 32, nullable: false })
  readonly name!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly generation!: number;

  // A full read in progress: its phase and where it stopped.
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  readonly full_phase!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly full_after!: string | null;

  // The finalized height the full read started at; the feed follows on
  // from the next one.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly full_from_height!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_full_at!: number | null;

  // The next height the change feed is read from; null before the first
  // full read starts.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly feed_next!: number | null;

  // The finalized block time (ms) of read_height, saved with it by each run
  // that reads the chain: once the feed has applied through read_height,
  // the chain has been read through this time. Null before the first such
  // run; nullable, so the schema sync only adds it.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly read_time!: number | null;

  // The highest height a run has read at: a run never reads below it.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly read_height!: number | null;

  // The chain's network id; another one means a relaunched chain.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly network!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  // Parts of the block at feed_next already applied (a block too large for
  // one batch is applied in parts).
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly feed_part!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(CHAIN_WAVES_TABLE)
export class ChainWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly wave_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'boolean', nullable: false })
  readonly members_only!: boolean;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly read_group_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly post_group_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly admin_group_id!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_GROUPS_TABLE)
export class ChainGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly group_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Column({ type: 'int', nullable: false })
  readonly version!: number;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_WAVE_ROLES_TABLE)
export class ChainWaveRoleEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 16, nullable: false })
  readonly role!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly principal_id!: string;

  @Column({ type: 'boolean', nullable: false })
  readonly live!: boolean;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_DECISIONS_TABLE)
export class ChainDecisionEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly kind!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly next_result_time!: number;

  @Column({ type: 'boolean', nullable: false })
  readonly due!: boolean;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_ENTRIES_TABLE)
export class ChainEntryEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly entry_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly author!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  // A 128-bit amount.
  @Column({ type: 'decimal', precision: 40, scale: 0, nullable: false })
  readonly total!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Index()
  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_VOTES_TABLE)
export class ChainVoteEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly entry_id!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly voter!: string;

  // A 64-bit vote.
  @Column({ type: 'decimal', precision: 20, scale: 0, nullable: false })
  readonly value!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_height!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Index()
  @Column({ type: 'int', nullable: false })
  readonly generation!: number;
}

@Entity(CHAIN_RESULTS_TABLE)
export class ChainResultEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly result_time!: number;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly stage!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_POLLS_TABLE)
export class ChainPollEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly poll_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

@Entity(CHAIN_WAVE_REP_TABLE)
export class ChainWaveRepEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly wave_id!: string;

  @Index()
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly rater!: string;

  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly category_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly category_name!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly value!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_height!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;
}

@Entity(CHAIN_DECISION_LEADERBOARDS_TABLE)
export class ChainDecisionLeaderboardEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly scored_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  // The API's leaderboard without its rows (in chain_leaderboard_rows).
  // Kept for published decisions only; a board ranked by total keeps no
  // scoredAt (it is only the read's block time).
  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

/** A leaderboard's rows: its ACTIVE entries ranked by the native count. */
@Entity(CHAIN_LEADERBOARD_ROWS_TABLE)
@Index(['decision_id', 'rank'])
export class ChainLeaderboardRowEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly entry_id!: string;

  @Column({ type: 'int', nullable: false })
  readonly rank!: number;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly legacy_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly author!: string | null;

  // A time-weighted score (a 128-bit total times time) or the total.
  @Column({ type: 'decimal', precision: 65, scale: 0, nullable: false })
  readonly score!: string;

  @Column({ type: 'decimal', precision: 40, scale: 0, nullable: false })
  readonly total!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'int', nullable: false })
  readonly generation!: number;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}
