import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_CURATIONS_TABLE } from '@/constants';

@Entity(WAVE_CURATIONS_TABLE)
@Index('idx_wave_curations_wave_name_unique', ['wave_id', 'name'], {
  unique: true
})
@Index('idx_wave_curations_name', ['name'])
export class WaveCurationEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly name!: string;

  @Index('idx_wave_curations_wave_id')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Index('idx_wave_curations_community_group_id')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly community_group_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
