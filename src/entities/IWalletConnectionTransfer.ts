import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WALLET_CONNECTION_TRANSFERS_TABLE } from '@/constants';
import { WalletAuthClientType } from './IWalletAuthSession';

@Entity(WALLET_CONNECTION_TRANSFERS_TABLE)
export class WalletConnectionTransferEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, nullable: false })
  readonly id!: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: false })
  readonly transfer_code_hash!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly address!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly role!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly target_client_type!: WalletAuthClientType;

  @Column({
    type: 'datetime',
    precision: 3,
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)'
  })
  readonly created_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: false })
  readonly expires_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly consumed_at!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly consumed_session_id!: string | null;
}
