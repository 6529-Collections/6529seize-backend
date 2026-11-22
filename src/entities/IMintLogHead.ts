import { MINT_LOG_CARD_HEADS_TABLE, MINT_LOG_HEAD_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The last entry of the mint log chains that keep one sequence for all their
 * cards (tokens and NextGen; rememes and published files): one row each.
 * Writes lock their chain's row, so they run one at a time and their entries
 * keep write order. Ephemeral: a rebuild sets each row from the chain's last
 * entry.
 */
@Entity(MINT_LOG_HEAD_TABLE)
export class MintLogHeadEntity {
  @PrimaryColumn({ type: 'int' })
  readonly id!: number;

  /** Sequence of the last entry; -1 before the first. */
  @Column({ type: 'bigint' })
  readonly seq!: number;

  /** sha256 (hex) of the last entry's canonical JSON. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly hash!: string | null;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}

/**
 * The last entry of each collaboration's own sequence, keyed by drop id.
 * Ephemeral like the chain heads.
 */
@Entity(MINT_LOG_CARD_HEADS_TABLE)
export class MintLogCardHeadEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly card_key!: string;

  @Column({ type: 'bigint' })
  readonly seq!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly hash!: string | null;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
