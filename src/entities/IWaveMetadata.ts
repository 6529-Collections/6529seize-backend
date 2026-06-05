import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WAVES_METADATA_TABLE } from '@/constants';

@Entity(WAVES_METADATA_TABLE)
@Index('idx_waves_metadatas_wave_data_key_unique', ['wave_id', 'data_key'], {
  unique: true
})
export class WaveMetadataEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  readonly data_key!: string;

  @Column({ type: 'text', nullable: false })
  readonly data_value!: string;
}
