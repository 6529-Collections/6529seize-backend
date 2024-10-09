import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WAVE_DROPPER_METRICS_TABLE } from '../constants';

@Entity(WAVE_DROPPER_METRICS_TABLE)
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
