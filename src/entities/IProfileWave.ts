import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILE_WAVES_TABLE } from '@/constants';

@Entity(PROFILE_WAVES_TABLE)
export class ProfileWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  profile_id!: string;

  @Index('idx_profile_waves_wave_id_unique', { unique: true })
  @Column({ type: 'varchar', length: 100, nullable: false })
  wave_id!: string;
}
