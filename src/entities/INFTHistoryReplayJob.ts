import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { NFTS_HISTORY_REPLAY_JOBS_TABLE } from '@/constants';

@Entity(NFTS_HISTORY_REPLAY_JOBS_TABLE)
export class NFTHistoryReplayJobEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  job_id!: string;

  @Column({ type: 'varchar', length: 64 })
  digest!: string;

  @Column({ type: 'text' })
  request_json!: string;

  @Column({ type: 'longtext' })
  manifest_json!: string;

  @Column({ type: 'int', default: 0 })
  next_index!: number;

  @CreateDateColumn()
  created_at!: Date;
}
