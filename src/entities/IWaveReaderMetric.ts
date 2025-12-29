import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WAVE_READER_METRICS_TABLE } from '../constants';

@Entity(WAVE_READER_METRICS_TABLE)
export class WaveReaderMetricEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly reader_id!: string;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly latest_read_timestamp!: number;
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly muted!: boolean;
}
