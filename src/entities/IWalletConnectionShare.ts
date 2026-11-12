import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WALLET_CONNECTION_SHARES_TABLE } from '@/constants';
import { WalletAuthClientType } from './IWalletAuthSession';

@Entity(WALLET_CONNECTION_SHARES_TABLE)
export class WalletConnectionShareEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, nullable: false })
  readonly id!: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: false })
  readonly connection_share_code_hash!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly address!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly role!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly target_client_type!: WalletAuthClientType;

  /** One-time target-device setup. The decryption key stays in the link fragment. */
  @Column({ type: 'text', nullable: true, default: null })
  readonly encrypted_device_setup!: string | null;

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

  /**
   * Coarse client family of the request that redeemed the share (for example
   * `desktop` or `browser`); never the user agent itself. Null for shares
   * retired by a newer share or redeemed before this column existed.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly consumed_client_family?: string | null;
}
