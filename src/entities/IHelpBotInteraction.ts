import { HELP_BOT_INTERACTIONS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export enum HelpBotInteractionStatus {
  SEEN = 'SEEN',
  ANSWERING = 'ANSWERING',
  ANSWERED = 'ANSWERED',
  NO_RELIABLE_SOURCE = 'NO_RELIABLE_SOURCE',
  SPAM_SUPPRESSED = 'SPAM_SUPPRESSED',
  INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS',
  FAILED = 'FAILED'
}

export enum HelpBotInteractionTriggerType {
  MENTION = 'MENTION',
  BOT_REPLY = 'BOT_REPLY'
}

@Entity(HELP_BOT_INTERACTIONS_TABLE)
@Index(['trigger_drop_id'], { unique: true })
@Index(['status', 'created_at'])
@Index(['wave_id', 'created_at'])
@Index(['author_id', 'created_at'])
export class HelpBotInteractionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  trigger_drop_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  target_drop_id!: string | null;

  @Column({ type: 'varchar', length: 100 })
  wave_id!: string;

  @Column({ type: 'varchar', length: 100 })
  author_id!: string;

  @Column({ type: 'varchar', length: 32 })
  trigger_type!: HelpBotInteractionTriggerType;

  @Column({ type: 'text' })
  question!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  parent_bot_drop_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  bot_reply_drop_id!: string | null;

  @Column({ type: 'varchar', length: 64 })
  status!: HelpBotInteractionStatus;

  @Column({ type: 'varchar', length: 100 })
  knowledge_version!: string;

  @Column({ type: 'text', nullable: true, default: null })
  failure_reason!: string | null;

  @Column({ type: 'bigint' })
  created_at!: number;

  @Column({ type: 'bigint' })
  updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  answer_started_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  completed_at!: number | null;
}
