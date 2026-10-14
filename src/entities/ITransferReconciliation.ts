import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TRANSFER_RECONCILIATIONS_TABLE } from '@/constants';

@Entity(TRANSFER_RECONCILIATIONS_TABLE)
@Index('uq_transfer_reconciliation_consumer_wallet', ['consumer', 'wallet'], {
  unique: true
})
@Index('idx_transfer_reconciliation_pending', ['consumer', 'enqueue_order'])
export class TransferReconciliationEntity {
  // A database-allocated ordering key avoids cross-producer clock skew.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  enqueue_order!: number;

  @Column({ type: 'varchar', length: 20 })
  consumer!: string;

  @Column({ type: 'varchar', length: 42 })
  wallet!: string;

  @Column({ type: 'varchar', length: 36 })
  revision!: string;

  @Column({ type: 'bigint' })
  requested_at!: number;
}
