import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_METRICS_TABLE } from '@/constants';

@Entity(WAVE_METRICS_TABLE)
@Index('idx_wmet_dc_wi', ['drops_count', 'wave_id'])
@Index('idx_wmet_ldt_wi', ['latest_drop_timestamp', 'wave_id'])
@Index('idx_wmet_sc_wi', ['subscribers_count', 'wave_id'])
export class WaveMetricEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly participatory_drops_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly subscribers_count!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly latest_drop_timestamp!: number;
}
