import { Column, Entity, PrimaryColumn } from 'typeorm';
import { VOTE_EVENTS_TABLE } from '../constants';
import { VoteMatterTargetType } from './IVoteMatter';

@Entity(VOTE_EVENTS_TABLE)
export class VoteEvent {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;
  @Column({ type: 'varchar', length: 50 })
  voter_wallet!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_target_id!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_target_type!: VoteMatterTargetType;
  @Column({ type: 'varchar', length: 256 })
  matter!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_category!: string;
  @Column({ type: 'varchar', length: 256 })
  event_reason!: VoteEventReason;
  @Column({ type: 'int' })
  amount!: number;
  @Column({ type: 'timestamp' })
  created_time!: Date;
}

export enum VoteEventReason {
  USER_VOTED = 'USER_VOTED',
  TDH_CHANGED = 'TDH_CHANGED'
}
