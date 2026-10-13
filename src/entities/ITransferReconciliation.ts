import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TRANSFER_RECONCILIATIONS_TABLE } from '@/constants';

@Entity(TRANSFER_RECONCILIATIONS_TABLE)
@Index('idx_transfer_reconciliation_pending', [
  'consumer',
  'requested_at',
  'wallet'
])
export class TransferReconciliationEntity {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  consumer!: string;

  @PrimaryColumn({ type: 'varchar', length: 42 })
  wallet!: string;

  @Column({ type: 'varchar', length: 36 })
  revision!: string;

  @Column({ type: 'bigint' })
  requested_at!: number;
}
