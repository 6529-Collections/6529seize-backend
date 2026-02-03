import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { EXTERNAL_INDEXED_TRANSFERS_TABLE } from '@/constants';

@Entity(EXTERNAL_INDEXED_TRANSFERS_TABLE)
@Index(['partition', 'block_number', 'log_index'])
@Index(['partition', 'token_id', 'block_number', 'log_index'])
@Index(['chain', 'block_number', 'log_index'])
@Index(['tx_hash'])
export class ExternalIndexedTransfersEntity {
  @PrimaryColumn({ type: 'varchar', length: 90 })
  readonly partition!: string;

  @PrimaryColumn({ type: 'bigint' })
  readonly block_number!: number;

  @PrimaryColumn({ type: 'int', nullable: false })
  readonly log_index!: number;

  @Column({ type: 'int', nullable: false })
  readonly chain!: number;

  @Column({ type: 'varchar', nullable: false, length: 42 })
  readonly contract!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly token_id!: number;

  @Column({ type: 'varchar', nullable: false, length: 42 })
  readonly from!: string;

  @Column({ type: 'varchar', nullable: false, length: 42 })
  readonly to!: string;

  @Column({ type: 'bigint', nullable: false, default: 1 })
  readonly amount!: number;

  @Column({ type: 'tinyint', width: 1, nullable: true })
  readonly is_monetary_sale!: number | null;

  @Column({ type: 'varchar', nullable: false, length: 66 })
  readonly tx_hash!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly time!: number;

  @Column({ type: 'tinyint', nullable: false, width: 1, default: 0 })
  readonly sale_epoch_start!: number;

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
