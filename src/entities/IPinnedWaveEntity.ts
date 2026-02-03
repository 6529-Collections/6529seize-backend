import { Entity, PrimaryColumn } from 'typeorm';
import { PINNED_WAVES_TABLE } from '@/constants';

@Entity(PINNED_WAVES_TABLE)
export class PinnedWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  profile_id!: number;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  wave_id!: number;
}
