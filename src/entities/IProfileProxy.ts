import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILE_PROXIES_TABLE } from '@/constants';

@Entity(PROFILE_PROXIES_TABLE)
@Index('idx_profile_proxies_target_id', ['target_id'])
@Index('idx_profile_proxies_created_by', ['created_by'])
export class ProfileProxyEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly target_id!: string;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly created_by!: string;
}
