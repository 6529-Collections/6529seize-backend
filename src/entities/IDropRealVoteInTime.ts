import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_REAL_VOTE_IN_TIME_TABLE } from '@/constants';

@Index('drop_real_vote_in_time_drop_id_timestamp_idx', ['drop_id', 'timestamp'])
@Entity(DROP_REAL_VOTE_IN_TIME_TABLE)
export class DropRealVoteInTimeEntity {
  @PrimaryGeneratedColumn('increment')
  readonly id!: number;
  @Index('drop_real_vote_in_time_drop_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;
  @Index('drop_real_vote_in_time_wave_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly timestamp!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly vote!: number;
}

export type DropRealVoteInTimeWithoutId = Omit<DropRealVoteInTimeEntity, 'id'>;
