import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_VOTES_TABLE } from '../constants';

@Entity(DROP_VOTES_TABLE)
@Index('drop_vote_drop_id_rater_profile_id_uindex', ['drop_id', 'voter_id'], {
  unique: true
})
export class DropVoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly drop_id!: string;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly voter_id!: string;
  @Column({ type: 'bigint', nullable: false })
  readonly vote!: number;
}
