import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CHAIN_CLAIM_BUILDS_TABLE,
  CHAIN_DECISION_LEADERBOARDS_TABLE,
  CHAIN_DECISIONS_TABLE,
  CHAIN_ENTRIES_TABLE,
  CHAIN_EVENTS_TABLE,
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

  // The next height whose events chain_events doesn't hold yet; null before
  // the first.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly events_next!: number | null;

  // The full read that last had to check every row again (the first one,
  // or one after the feed lost the cursor): until it completes, only rows
  // it or the feed wrote tell an event what was there before.
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly trust_from!: number;

  // The vote scan as the event log last saw it (JSON: scanning,
  // finishedDay, the reduction under way): it tells a scan's cut from a
  // voter's own VOTE_SET.
  @Column({ type: 'varchar', length: 300, nullable: true, default: null })
  readonly scan_state!: string | null;

  // Entries whose vote records the node could not decode, to read whole at
  // the feed's height, and those votes (JSON: entries, votes).
  @Column({ type: 'text', nullable: true, default: null })
  readonly vote_rereads!: string | null;

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

  // The mirror reads the decisions written above a height.
  @Index()
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

  // The mirror reads the results written above a height.
  @Index()
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

/**
 * The chain index's event log (src/waves-chain-index/waves-chain-index.events.ts):
 * what changed in each finalized block, as the change feed and the index
 * before it tell, in the order a block's records come (`seq`). Append
 * only: written once per block, by the pass that applies the block, never
 * by a full read. The cursor is `height:seq@network`.
 */
@Entity(CHAIN_EVENTS_TABLE)
@Index(['kind', 'height', 'seq'])
@Index(['entry_id', 'height'])
@Index(['poll_id', 'actor'])
export class ChainEventEntity {
  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly height!: number;

  // The event's place among its block's events.
  @PrimaryColumn({ type: 'int', nullable: false })
  readonly seq!: number;

  // The block's time (its slot's start, ms).
  @Column({ type: 'bigint', nullable: false })
  readonly block_time!: number;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly kind!: string;

  // OPERATION, SCAN (the daily vote scan), RELEASE (a vote released from
  // an entry no longer ACTIVE or a decision no longer PUBLISHED),
  // AMBIGUOUS (a scan's cut or the voter's own VOTE_SET, which the records
  // can't tell apart) or SYSTEM (a GAP).
  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly origin!: string;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly wave_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly wave_legacy_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly decision_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly decision_legacy_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly entry_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly entry_legacy_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly poll_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly poll_legacy_id!: string | null;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly group_id!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly group_legacy_id!: string | null;

  // Who acted: the voter, the ballot's TDH cluster, the entry's author, the
  // wave's creator, the group's controller, the moderator.
  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly actor!: string | null;

  @Column({ type: 'json', nullable: false })
  readonly data!: unknown;
}

/**
 * The Main Stage claim builds (waves-chain-index.claims.ts): one a
 * (network, decision, occurrence), written by the event log with the
 * events of the block whose Result went final, or by the claim build
 * catch-up from the index's result rows for a result the log never saw.
 * Sent to the claims-builder queue after that commits and retried each run
 * until a send succeeds. A row is never written twice, so a replayed or
 * rebuilt log, or the catch-up, sends nothing again. Not emptied with the
 * index.
 */
@Entity(CHAIN_CLAIM_BUILDS_TABLE)
@Index(['status', 'height'])
export class ChainClaimBuildEntity {
  // The chain's network id ('' when the head gave none).
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly network!: string;

  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly decision_id!: string;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly occurrence!: number;

  // The block the result went final in.
  @Column({ type: 'bigint', nullable: false })
  readonly height!: number;

  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly entry_id!: string;

  // 6529.io's drop id of the entry (its legacy id), if it has one.
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly drop_id!: string | null;

  // The message to send; null when none is sent.
  @Column({ type: 'json', nullable: true, default: null })
  readonly message!: unknown;

  // pending, sent, or skipped (with the reason).
  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly reason!: string | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly sent_at!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly message_id!: string | null;
}
