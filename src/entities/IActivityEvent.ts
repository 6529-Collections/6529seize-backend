import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ACTIVITY_EVENTS_TABLE } from '@/constants';

@Entity(ACTIVITY_EVENTS_TABLE)
export class ActivityEventEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: bigint;
  @Index('activity_events_target_id_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_id!: string;
  @Index('activity_events_target_type_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly target_type!: ActivityEventTargetType;
  @Index('activity_events_action_idx')
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly action!: ActivityEventAction;
  @Column({ type: 'json', nullable: false })
  readonly data!: string;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly visibility_group_id!: string | null;
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly wave_id!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly action_author_id!: string | null;
}

export enum ActivityEventTargetType {
  IDENTITY = 'IDENTITY',
  WAVE = 'WAVE',
  DROP = 'DROP'
}

export enum ActivityEventAction {
  DROP_CREATED = 'DROP_CREATED',
  WAVE_CREATED = 'WAVE_CREATED',
  DROP_REPLIED = 'DROP_REPLIED'
}
