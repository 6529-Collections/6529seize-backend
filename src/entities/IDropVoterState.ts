import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DROP_VOTER_STATE_TABLE } from '@/constants';

@Entity(DROP_VOTER_STATE_TABLE)
@Index(
  'idx_drop_voter_states_drop_votes_voter',
  ['drop_id', 'votes', 'voter_id'],
  { synchronize: false }
)
export class DropVoterStateEntity {
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
