import { Column, Entity, PrimaryColumn } from 'typeorm';
import { RATE_EVENTS_TABLE } from '../constants';
import { RateMatterTargetType } from './IRateMatter';

@Entity(RATE_EVENTS_TABLE)
export class RateEvent {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;
  @Column({ type: 'varchar', length: 50 })
  rater!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_target_id!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_target_type!: RateMatterTargetType;
  @Column({ type: 'varchar', length: 256 })
  matter!: string;
  @Column({ type: 'varchar', length: 256 })
  matter_category!: string;
  @Column({ type: 'varchar', length: 256 })
  event_reason!: RateEventReason;
  @Column({ type: 'int' })
  amount!: number;
  @Column({ type: 'timestamp' })
  created_time!: Date;
}

export enum RateEventReason {
  USER_RATED = 'USER_RATED',
  TDH_CHANGED = 'TDH_CHANGED'
}
