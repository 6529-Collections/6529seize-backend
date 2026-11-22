import { MINT_LOG_HEAD_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The mint log's last entry: one row. Writes to the minting tables lock it,
 * so they run one at a time and their log entries keep write order. It is
 * ephemeral: a rebuild sets it from the last entry in the log.
 */
@Entity(MINT_LOG_HEAD_TABLE)
export class MintLogHeadEntity {
  @PrimaryColumn({ type: 'int' })
  readonly id!: number;

  /** Sequence of the last entry; -1 before the genesis entry. */
  @Column({ type: 'bigint' })
  readonly seq!: number;

  /** sha256 (hex) of the last entry's canonical JSON. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly hash!: string | null;

  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}
