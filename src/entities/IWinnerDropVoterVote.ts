import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { WINNER_DROP_VOTER_VOTES_TABLE } from '@/constants';

@Entity(WINNER_DROP_VOTER_VOTES_TABLE)
export class WinnerDropVoterVoteEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly voter_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly votes!: number;
  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
}
