import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TDH_CHAIN_DAYS_TABLE } from '@/constants/db-tables';

/**
 * One TDH day read from the 6529 chain: its header, where it applied, and
 * what the site did with it. An index of the chain: a rebuild reads the
 * same days from the gateway and writes the same rows.
 *
 * - `mode`: SHADOW (compared only) or CHAIN (written into the TDH tables).
 * - `status`: FAILED (a check failed, nothing written), SKIPPED (a newer
 *   day was already in the tables), WRITTEN (the tables hold the day, which
 *   was recorded in the same transaction; follow-up steps are due) or
 *   INGESTED (done).
 * - `steps_done`: the follow-up steps of a CHAIN write already run (nfts,
 *   history, metrics, uploads, dayFiles), so a retry resumes instead of
 *   rewriting. `step_tries` counts each step's failed runs; a step that
 *   fails too often, or that a newer day's write has made moot, goes to
 *   `steps_given_up` (with an alert) and the day is done without it.
 * - `superseded_at`: set when the old path wrote the same block after this
 *   day (a rollback, or the delegations loop's rerun): the tables no longer
 *   hold the chain's values for it, and `/api/blocks` says SITE.
 * - `redo_note`: a later attempt at this written day that failed or was
 *   skipped. It never replaces the record of what the tables hold.
 * - `deferred_keys`: consolidations left out because their key is wider
 *   than the columns; the day is written again once the columns are wide
 *   enough.
 * - `verdict`: the exact comparison of the site's values with the chain's
 *   leaves: MATCH, MATCH_WITHOUT_TOKENS (no token list to compare per-card
 *   values) or MISMATCH; `compare_summary` holds the counts.
 */
@Entity(TDH_CHAIN_DAYS_TABLE)
export class TdhChainDayEntity {
  @PrimaryColumn({ type: 'int' })
  readonly cycle_day!: number;

  @Column({ type: 'varchar', length: 16 })
  readonly mode!: string;

  @Column({ type: 'varchar', length: 32 })
  readonly status!: string;

  @Column({ type: 'int' })
  readonly block!: number;

  @Column({ type: 'bigint' })
  readonly boundary!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly cutoff_hash!: string;

  @Column({ type: 'bigint' })
  readonly cutoff_timestamp!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly wallet_root!: string;

  @Column({ type: 'int' })
  readonly wallet_count!: number;

  @Column({ type: 'int' })
  readonly identity_count!: number;

  @Column({ type: 'bigint' })
  readonly total_tdh!: number;

  @Column({ type: 'varchar', length: 66 })
  readonly token_root!: string;

  @Column({ type: 'int' })
  readonly token_count!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly apply_height!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly apply_time_ms!: number | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  readonly verdict!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly compare_summary!: unknown;

  @Column({ type: 'json', nullable: true })
  readonly deferred_keys!: string[] | null;

  @Column({ type: 'json', nullable: true })
  readonly steps_done!: string[] | null;

  @Column({ type: 'json', nullable: true })
  readonly step_tries!: Record<string, number> | null;

  @Column({ type: 'json', nullable: true })
  readonly steps_given_up!: string[] | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly superseded_at!: number | null;

  @Column({ type: 'json', nullable: true })
  readonly redo_note!: unknown;

  /** The day files (`tdh-day-file.ts`) as published on Arweave. */
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly wallets_file_url!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  readonly wallets_file_sha256!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly tokens_file_url!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  readonly tokens_file_sha256!: string | null;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
