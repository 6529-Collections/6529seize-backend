import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_LATEST_LOG_TABLE } from '@/constants';

@Entity(PROFILE_LATEST_LOG_TABLE)
export class ProfileLatestLogEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'datetime', nullable: false })
  readonly latest_activity!: Date;
}
