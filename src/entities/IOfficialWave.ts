import { Entity, PrimaryColumn } from 'typeorm';
import { OFFICIAL_WAVES_TABLE } from '@/constants';

@Entity(OFFICIAL_WAVES_TABLE)
export class OfficialWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  wave_id!: string;
}
