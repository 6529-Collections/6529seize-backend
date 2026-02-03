import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PROFILE_GROUP_CHANGES } from '@/constants';

@Entity(PROFILE_GROUP_CHANGES)
@Index(['profile_id', 'chg_time'])
export class ProfileGroupChangeEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;

  @Index()
  @Column({ type: 'bigint', nullable: false })
  readonly chg_time!: number;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly profile_id!: string;
}
