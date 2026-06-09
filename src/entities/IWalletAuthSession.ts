import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WALLET_AUTH_SESSIONS_TABLE } from '@/constants';

export type WalletAuthClientType = 'web' | 'native';

@Entity(WALLET_AUTH_SESSIONS_TABLE)
export class WalletAuthSession {
  @PrimaryColumn({ type: 'varchar', length: 36, nullable: false })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly address!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly role!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly client_type!: WalletAuthClientType;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly secret_hash!: string | null;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly refresh_token_hash!: string | null;

  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly user_agent_hash!: string | null;

  @Column({
    type: 'datetime',
    precision: 3,
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)'
  })
  readonly created_at!: Date;

  @Column({
    type: 'datetime',
    precision: 3,
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)'
  })
  readonly last_used_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: false })
  readonly expires_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly revoked_at!: Date | null;
}
