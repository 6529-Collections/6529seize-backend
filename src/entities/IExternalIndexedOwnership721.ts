import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EXTERNAL_INDEXED_OWNERSHIP_721_TABLE } from '@/constants';

@Entity(EXTERNAL_INDEXED_OWNERSHIP_721_TABLE)
@Index(['partition', 'token_id'])
export class ExternalIndexedOwnership721Entity {
  @PrimaryColumn({ type: 'varchar', length: 90 })
  readonly partition!: string;

  @PrimaryColumn({ type: 'bigint' })
  readonly token_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly owner!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly since_block!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly since_time!: number;

  @Column({ type: 'bigint', nullable: true })
  readonly sale_epoch_start_block!: number | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  readonly sale_epoch_tx!: string | null;

  @Column({ type: 'int', default: 0 })
  readonly free_transfers_since_epoch!: number;

  @Column({
    type: 'bigint'
  })
  readonly created_at!: number;

  @Column({
    type: 'bigint'
  })
  readonly updated_at!: number;
}
