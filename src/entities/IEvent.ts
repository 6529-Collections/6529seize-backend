import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EVENTS_TABLE, LISTENER_PROCESSED_EVENTS_TABLE } from '@/constants';

@Entity(LISTENER_PROCESSED_EVENTS_TABLE)
@Index('l_proc_event_idx', ['event_id', 'listener_key'], { unique: true })
export class ListenerProcessedEvent {
  @PrimaryGeneratedColumn('increment')
  id?: number;
  @Column({ type: 'bigint' })
  event_id!: number;
  @Column({ type: 'varchar', length: 50 })
  listener_key!: string;
}

@Entity(EVENTS_TABLE)
@Index('event_order_idx', ['type', 'status', 'created_at'])
export class ProcessableEvent {
  @PrimaryGeneratedColumn('increment')
  id!: number;
  @Column({ type: 'varchar', length: 50 })
  type!: EventType;
  @Column({ type: 'varchar', length: 50 })
  status!: EventStatus;
  @Column({ type: 'json' })
  data!: string;
  @Column({ type: 'bigint' })
  created_at!: number;
  @Column({ type: 'bigint', nullable: true, default: null })
  processed_at!: number | null;
}

export enum EventType {
  PROFILE_CIC_RATE = 'PROFILE_CIC_RATE',
  PROFILE_REP_RATE = 'PROFILE_REP_RATE'
}

export enum EventStatus {
  NEW = 'NEW',
  PROCESSED = 'PROCESSED'
}
