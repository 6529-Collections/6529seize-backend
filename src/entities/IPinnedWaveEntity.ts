import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PINNED_WAVES_TABLE } from '@/constants';

@Entity(PINNED_WAVES_TABLE)
@Index('idx_pinned_wave_position_profile', ['position', 'profile_id'])
export class PinnedWaveEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  profile_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  wave_id!: string;

  // Positions are assigned under the profile lock and can be swapped in one statement.
  @Column({ type: 'int', unsigned: true, nullable: true })
  position!: number | null;
}
