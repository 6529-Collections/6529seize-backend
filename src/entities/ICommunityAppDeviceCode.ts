import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { COMMUNITY_APP_DEVICE_CODES_TABLE } from '@/constants';

@Entity(COMMUNITY_APP_DEVICE_CODES_TABLE)
export class CommunityAppDeviceCodeEntity {
  @PrimaryColumn({ type: 'varchar', length: 36, nullable: false })
  readonly id!: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: false })
  readonly device_code_hash!: string;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64, nullable: false })
  readonly user_code_hash!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly client_id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly redirect_uri!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly scope!: string;

  @Column({ type: 'char', length: 128, nullable: false })
  readonly pkce_code_challenge!: string;

  @Column({ type: 'varchar', length: 10, nullable: false })
  readonly pkce_code_challenge_method!: string; // 'S256'

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly approved_by_address!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly approved_by_role!: string | null;

  @Column({ type: 'datetime', precision: 3, nullable: false, default: () => 'CURRENT_TIMESTAMP(3)' })
  readonly created_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: false })
  readonly expires_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly approved_at!: Date | null;

  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly consumed_at!: Date | null;
}