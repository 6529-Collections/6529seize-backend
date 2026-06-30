import { WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE)
@Index('idx_wdmrr_dirty_wave', ['dirty_at', 'wave_id'])
export class WaveDropMetricsRefreshRequestEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly reason!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly dirty_at!: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
