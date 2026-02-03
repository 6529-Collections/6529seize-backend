import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_REAL_VOTER_VOTE_IN_TIME_TABLE } from '@/constants';

@Entity(DROP_REAL_VOTER_VOTE_IN_TIME_TABLE)
export class DropRealVoterVoteInTimeEntity {
  @PrimaryGeneratedColumn('increment')
  readonly id!: number;
  @Index('drop_real_voter_vote_in_time_drop_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;
  @Index('drop_real_voter_vote_in_time_voter_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voter_id!: string;
  @Index('drop_real_voter_vote_in_time_wave_id_idx')
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly timestamp!: number;
  @Column({ type: 'bigint', nullable: false })
  readonly vote!: number;
}

export type DropRealVoterVoteInTimeEntityWithoutId = Omit<
  DropRealVoterVoteInTimeEntity,
  'id'
>;
