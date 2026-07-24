import { WAVE_SCORE_REFRESH_REQUESTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RetryableRefreshRequestEntity } from './IRetryableRefreshRequest';

@Entity(WAVE_SCORE_REFRESH_REQUESTS_TABLE)
@Index('idx_wsrr_dirty_wave', ['dirty_at', 'wave_id'])
export class WaveScoreRefreshRequestEntity extends RetryableRefreshRequestEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly reason!: string;
}
