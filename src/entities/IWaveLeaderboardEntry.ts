import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WAVE_LEADERBOARD_ENTRIES_TABLE } from '@/constants';

@Entity(WAVE_LEADERBOARD_ENTRIES_TABLE)
export class WaveLeaderboardEntryEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;
  @Index('wave_leaderboard_entries_wave_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly timestamp!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly vote!: number;
  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly vote_on_decision_time!: number;
}
