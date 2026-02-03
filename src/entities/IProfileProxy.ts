import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_PROXIES_TABLE } from '@/constants';

@Entity(PROFILE_PROXIES_TABLE)
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
