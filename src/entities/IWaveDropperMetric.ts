import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_DROPPER_METRICS_TABLE } from '@/constants';

@Entity(WAVE_DROPPER_METRICS_TABLE)
@Index(
  'idx_wdm_dropper_latest_wave',
  ['dropper_id', 'latest_drop_timestamp', 'wave_id'],
  { synchronize: false }
)
export class WaveDropperMetricEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly dropper_id!: string;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly participatory_drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly latest_drop_timestamp!: number;
}
