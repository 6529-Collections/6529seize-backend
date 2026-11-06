import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TRANSACTION_SCAN_CHECKPOINTS_TABLE } from '@/constants';

@Entity(TRANSACTION_SCAN_CHECKPOINTS_TABLE)
export class TransactionScanCheckpoint {
  @PrimaryColumn({ type: 'int' }) chain_id!: number;
  @PrimaryColumn({ type: 'varchar', length: 42 }) contract!: string;
  @Column({ type: 'int' }) block!: number;
  @Column({ type: 'varchar', length: 66 }) block_hash!: string;
  @Column({ type: 'bigint' }) updated_at!: number;
}
