import { HELP_BOT_CREDIT_EVENTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum HelpBotCreditEventType {
  SIGNUP_GRANT = 'SIGNUP_GRANT',
  PROFILE_SETUP_GRANT = 'PROFILE_SETUP_GRANT',
  DAILY_ACTIVITY_GRANT = 'DAILY_ACTIVITY_GRANT',
  QUESTION_SPEND = 'QUESTION_SPEND',
  QUESTION_REFUND = 'QUESTION_REFUND'
}

@Entity(HELP_BOT_CREDIT_EVENTS_TABLE)
@Index(
  'help_bot_credit_event_dedupe_idx',
  ['profile_id', 'event_type', 'source_id'],
  {
    unique: true
  }
)
@Index(['profile_id', 'created_at'])
@Index(['event_type', 'created_at'])
export class HelpBotCreditEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  profile_id!: string;

  @Column({ type: 'varchar', length: 100 })
  bot_profile_id!: string;

  @Column({ type: 'varchar', length: 32 })
  event_type!: HelpBotCreditEventType;

  @Column({ type: 'varchar', length: 128 })
  source_id!: string;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'bigint' })
  created_at!: number;
}
