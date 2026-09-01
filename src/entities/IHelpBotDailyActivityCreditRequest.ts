import { HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum HelpBotDailyActivityCreditRequestStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  DEAD = 'DEAD'
}

@Entity(HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUESTS_TABLE)
@Index('idx_hbdacr_pending_due', ['status', 'next_attempt_at'])
@Index('idx_hbdacr_pending_order', [
  'status',
  'attempts',
  'requested_at',
  'profile_id',
  'next_attempt_at'
])
@Index('idx_hbdacr_completed', ['status', 'completed_at'])
export class HelpBotDailyActivityCreditRequestEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  profile_id!: string;

  @PrimaryColumn({ type: 'char', length: 10 })
  activity_date!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: HelpBotDailyActivityCreditRequestStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'bigint' })
  next_attempt_at!: number;

  @Column({ type: 'text', nullable: true, default: null })
  last_error!: string | null;

  @Column({ type: 'bigint' })
  requested_at!: number;

  @Column({ type: 'bigint' })
  updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  completed_at!: number | null;
}
