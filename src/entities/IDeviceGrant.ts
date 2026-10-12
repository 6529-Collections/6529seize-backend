import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DEVICE_GRANTS_TABLE } from '@/constants';

@Entity(DEVICE_GRANTS_TABLE)
export class DeviceGrantEntity {
  // EIP-191 hash of the exact SIWE message the wallet signed.
  @PrimaryColumn({ type: 'varchar', length: 66, nullable: false })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 42, nullable: false })
  readonly wallet!: string;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly key_type!: string;

  @Index()
  @Column({ type: 'varchar', length: 66, nullable: false })
  readonly device_key!: string;

  // Comma separated, canonical order.
  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly scopes!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly device_label!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly domain!: string;

  @Column({ type: 'text', nullable: false })
  readonly message!: string;

  @Column({ type: 'text', nullable: false })
  readonly wallet_signature!: string;

  @Column({ type: 'int', nullable: false })
  readonly chain_id!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly issued_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly expires_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly revoked_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly last_used_at!: number | null;
}
