import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DROP_VOTE_CHANGES } from '../constants';

@Entity(DROP_VOTE_CHANGES)
export class DropVoteChange {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: number;
  @Column({ type: 'varchar', length: 100 })
  readonly voter_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'bigint' })
  readonly vote_change!: number;
  @Column({ type: 'bigint' })
  readonly timestamp!: number;
}
