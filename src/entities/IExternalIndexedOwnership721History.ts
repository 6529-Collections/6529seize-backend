import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE } from '@/constants';

@Entity(EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE)
@Index(['partition', 'token_id', 'block_number', 'log_index'])
@Index(['partition', 'token_id', 'since_time', 'block_number', 'log_index'])
export class ExternalIndexedOwnership721HistoryEntity {
  @PrimaryColumn({ type: 'varchar', length: 90, nullable: false })
  readonly partition!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly token_id!: string;

  @PrimaryColumn({ type: 'bigint', nullable: false })
  readonly block_number!: number;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly log_index!: number;

  @Index()
  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly owner!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly since_block!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly since_time!: number;

  @Column({ type: 'tinyint', width: 1, nullable: false, default: 0 })
  readonly acquired_as_sale!: number;

  @Column({ type: 'bigint', nullable: true })
  readonly sale_epoch_start_block!: number | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  readonly sale_epoch_tx!: string | null;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly created_at!: number;

  @Column({
    type: 'bigint',
    nullable: false
  })
  readonly updated_at!: number;
}
