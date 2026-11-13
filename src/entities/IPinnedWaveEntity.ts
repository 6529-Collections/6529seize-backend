import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PINNED_WAVES_TABLE } from '@/constants';

@Entity(PINNED_WAVES_TABLE)
export class PinnedWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  profile_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  wave_id!: string;

  @Column({ type: 'int', unsigned: true, nullable: true })
  position!: number | null;
}
