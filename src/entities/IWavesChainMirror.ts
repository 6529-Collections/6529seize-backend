import { Column, Entity, PrimaryColumn } from 'typeorm';
import {
  CHAIN_DOCS_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
  WAVES_CHAIN_MIRROR_DECISIONS_TABLE,
  WAVES_CHAIN_MIRROR_EVENTS_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE
} from '@/constants';

/**
 * Where the waves chain mirror (src/waves-chain-mirror) got to: its cursor
 * over the chain index's event log, the full pass under way, and what it
 * last saw of the index. One row; report-only runs never write it.
 */
@Entity(WAVES_CHAIN_MIRROR_STATE_TABLE)
export class WavesChainMirrorStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 32, nullable: false })
  readonly name!: string;

  // The chain's network id the mirror's rows come from.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly network!: string | null;

  // The cursor after the last event the mirror applied (height:seq@network);
  // null before the first.
  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly events_cursor!: string | null;

  // The index's full read the mirror last saw; a new one starts a full pass.
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly index_generation!: number;

  // The index's applied height at the mirror's last run: decisions the index
  // read again above it are mirrored again.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly index_height!: number | null;

  // A full pass under way: true, and the last decision id it finished
  // (null: none yet).
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly full_running!: boolean;

  @Column({ type: 'varchar', length: 66, nullable: true, default: null })
  readonly full_after!: string | null;

  // When the last full pass completed (ms); null before the first.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_full_at!: number | null;

  // Decisions that failed (JSON array of chain ids): tried again first.
  @Column({ type: 'text', nullable: true, default: null })
  readonly retry_ids!: string | null;

  // Decisions whose VOTE events are read again when next tried (a JSON
  // object of chain id to the cursor after which they are read; null: the
  // log's start): they failed, or were still catching up, after the event
  // cursor moved past them.
  @Column({ type: 'text', nullable: true, default: null })
  readonly replay_from!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * Documents the chain names (entry manifests and, later, wave and decision
 * documents), as the gateway's document store gave them and checked
 * against their CID. Kept so a rebuild of the mirror reads none again. A
 * document's other checks (commitment, the object it names) are made each
 * time it is used.
 */
@Entity(CHAIN_DOCS_TABLE)
export class ChainDocEntity {
  // The CID as 0x hex (a raw sha2-256 CIDv1 is 36 bytes).
  @PrimaryColumn({ type: 'varchar', length: 140, nullable: false })
  readonly cid!: string;

  // A document is kept in parts of up to 5,000 bytes, in order, so no
  // statement that writes it passes the RDS proxy's size.
  @PrimaryColumn({ type: 'int', nullable: false })
  readonly part!: number;

  // The class the first reader asked for (8: entry manifest).
  @Column({ type: 'int', nullable: false })
  readonly doc_class!: number;

  @Column({ type: 'blob', nullable: false })
  readonly bytes!: Buffer;

  @Column({ type: 'bigint', nullable: false })
  readonly first_seen!: number;
}

/**
 * Entries made on the chain that 6529.io holds back: the chain counts them,
 * 6529.io shows nothing of them. A refusal (moderation refused the content,
 * a manifest that can never check) is kept for good, so the entry is not
 * judged again each run; deleting the row has it judged again. A delay (the
 * manifest not in the store yet, moderation unavailable, over its hourly
 * limit, the author suspended) waits until retry_at, longer each time.
 */
@Entity(CHAIN_ENTRY_HOLDS_TABLE)
export class ChainEntryHoldEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly entry_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  // The refusal's or the delay's code.
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly reason!: string;

  // A delay's next try (ms); null for a refusal, kept for good.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly retry_at!: number | null;

  // Delays so far, each doubling the next wait.
  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly held_at!: number;
}

/**
 * The event log's VOTE events whose history the mirror wrote
 * (competition_vote_history and competition_score_history): each once,
 * though a run that stops early reads them again.
 */
@Entity(WAVES_CHAIN_MIRROR_EVENTS_TABLE)
export class WavesChainMirrorEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly network!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly height!: number;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly seq!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly applied_at!: number;
}

/**
 * The chain's groups the mirror wrote into community_groups and
 * profile_groups (a group made on the chain, or an imported one the chain
 * replaced), and the imported groups it only matched to their 6529.io row.
 */
@Entity(WAVES_CHAIN_MIRROR_GROUPS_TABLE)
export class WavesChainMirrorGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly chain_group_id!: string;

  // community_groups.id: the chain id for a group made on the chain, the
  // imported group's own id otherwise.
  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly group_id!: string;

  // The chain version written into community_groups; null for an imported
  // group only matched (6529.io's own row, left as it is).
  @Column({ type: 'int', nullable: true, default: null })
  readonly version!: number | null;

  // The profile_groups lists the mirror wrote for that version.
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly include_list_id!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly exclude_list_id!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * The chain's waves the mirror wrote into waves (a wave made on the chain,
 * or an imported one whose policy the chain replaced): what of the chain it
 * last wrote, so an unchanged wave is passed over, and what it holds back.
 */
@Entity(WAVES_CHAIN_MIRROR_WAVES_TABLE)
export class WavesChainMirrorWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly chain_wave_id!: string;

  // waves.id: the chain id for a wave made on the chain, the imported
  // wave's own id otherwise.
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  // The chain's policy version, document, controller and groups last
  // written (JSON); null while the wave waits.
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly written!: string | null;

  // The wave document whose fields were last written, and its metadata keys
  // (JSON array): a key the next document drops is deleted.
  @Column({ type: 'varchar', length: 140, nullable: true, default: null })
  readonly metadata_cid!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly metadata_keys!: string | null;

  // Why the wave, or its description, is held back; null when nothing is.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly held!: string | null;

  // A delay's next try (ms); null for a refusal, kept for good.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly retry_at!: number | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

/**
 * The mirror's record of a decision made on the chain: the competitions
 * row it is written to, the chain's policy version last written, and why
 * the version after it is held back.
 */
@Entity(WAVES_CHAIN_MIRROR_DECISIONS_TABLE)
export class WavesChainMirrorDecisionEntity {
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly chain_decision_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  // The policy version (configVersion) last written; null before the first.
  @Column({ type: 'int', nullable: true, default: null })
  readonly written!: number | null;

  // Why the policy version in held_version is held back; null when none is.
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly held!: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  readonly held_version!: number | null;

  // A delay's next try (ms); null for a refusal, kept until a new version.
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly retry_at!: number | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
