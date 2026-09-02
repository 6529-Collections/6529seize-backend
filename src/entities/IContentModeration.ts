import {
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  CONTENT_MODERATION_PROFILE_STATES_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  CONTENT_MODERATION_ROLES_TABLE
} from '@/constants';
import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn
} from 'typeorm';

export enum ContentReportReason {
  SCAM_OR_PHISHING = 'SCAM_OR_PHISHING',
  PRIVATE_INFORMATION_OR_DOXXING = 'PRIVATE_INFORMATION_OR_DOXXING',
  THREATS_OR_TARGETED_HARASSMENT = 'THREATS_OR_TARGETED_HARASSMENT',
  HATE_OR_DISCRIMINATION = 'HATE_OR_DISCRIMINATION',
  SEXUAL_EXPLOITATION_OR_ILLEGAL_CONTENT = 'SEXUAL_EXPLOITATION_OR_ILLEGAL_CONTENT',
  SPAM = 'SPAM',
  OTHER = 'OTHER'
}

export enum ContentReportStatus {
  OPEN = 'OPEN',
  RESOLVED_ALLOWED = 'RESOLVED_ALLOWED',
  RESOLVED_REMOVED = 'RESOLVED_REMOVED',
  WITHDRAWN = 'WITHDRAWN'
}

export enum ContentModerationRecommendation {
  NO_VIOLATION_DETECTED = 'NO_VIOLATION_DETECTED',
  NEEDS_HUMAN_REVIEW = 'NEEDS_HUMAN_REVIEW',
  URGENT_QUARANTINE = 'URGENT_QUARANTINE'
}

export enum DropModerationStatus {
  VISIBLE = 'VISIBLE',
  AI_QUARANTINED = 'AI_QUARANTINED',
  MODERATOR_REMOVED = 'MODERATOR_REMOVED'
}

export enum ModeratedProfileStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED'
}

export enum PrePublicationCheckOutcome {
  ALLOW = 'ALLOW',
  REJECT = 'REJECT'
}

@Entity(CONTENT_MODERATION_PROFILE_BLOCKS_TABLE)
@Index(['blocker_profile_id', 'blocked_profile_id'], { unique: true })
export class ContentModerationProfileBlockEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;

  @Index(`${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}_blocker_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly blocker_profile_id!: string;

  @Index(`${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE}_blocked_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly blocked_profile_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(CONTENT_MODERATION_HIDDEN_DROPS_TABLE)
@Index(['profile_id', 'drop_id'], { unique: true })
export class ContentModerationHiddenDropEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;

  @Index(`${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}_profile_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly profile_id!: string;

  @Index(`${CONTENT_MODERATION_HIDDEN_DROPS_TABLE}_drop_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(CONTENT_MODERATION_REPORTS_TABLE)
@Index(`${CONTENT_MODERATION_REPORTS_TABLE}_queue_idx`, [
  'status',
  'created_at'
])
@Index(`${CONTENT_MODERATION_REPORTS_TABLE}_drop_idx`, ['drop_id'])
export class ContentModerationReportEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly reporter_profile_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly author_profile_id!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly reason!: ContentReportReason;

  @Column({ type: 'text', nullable: true })
  readonly notes!: string | null;

  @Column({ type: 'json', nullable: false })
  readonly content_snapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly status!: ContentReportStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  readonly ai_recommendation!: ContentModerationRecommendation | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly ai_category!: string | null;

  @Column({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  readonly ai_confidence!: number | null;

  @Column({ type: 'text', nullable: true })
  readonly ai_rationale!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly ai_evidence!: unknown[] | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly ai_policy_version!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly ai_assessed_at!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly resolved_by_profile_id!: string | null;

  @Column({ type: 'text', nullable: true })
  readonly resolution_reason!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly resolved_at!: number | null;
}

@Entity(CONTENT_MODERATION_DROP_STATES_TABLE)
export class ContentModerationDropStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly drop_id!: string;

  @Index(`${CONTENT_MODERATION_DROP_STATES_TABLE}_status_idx`)
  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly status!: DropModerationStatus;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly updated_by_profile_id!: string | null;

  @Column({ type: 'text', nullable: true })
  readonly reason!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(CONTENT_MODERATION_ROLES_TABLE)
export class ContentModerationRoleEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly profile_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly created_by_profile_id!: string | null;
}

@Entity(CONTENT_MODERATION_PROFILE_STATES_TABLE)
export class ContentModerationProfileStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly status!: ModeratedProfileStatus;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly updated_by_profile_id!: string;

  @Column({ type: 'text', nullable: true })
  readonly reason!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(CONTENT_MODERATION_AUDIT_LOG_TABLE)
@Index(`${CONTENT_MODERATION_AUDIT_LOG_TABLE}_action_created_idx`, [
  'action',
  'created_at'
])
export class ContentModerationAuditLogEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  readonly id!: string;

  @Index(`${CONTENT_MODERATION_AUDIT_LOG_TABLE}_created_idx`)
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly actor_profile_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly action!: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly target_drop_id!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly target_profile_id!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly previous_state!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly new_state!: string | null;

  @Column({ type: 'text', nullable: true })
  readonly reason!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly metadata!: Record<string, unknown> | null;
}

@Entity(CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE)
@Index(`${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}_duplicate_idx`, [
  'author_profile_id',
  'content_fingerprint',
  'created_at'
])
export class ContentModerationPrePublicationCheckEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Index(`${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}_drop_idx`)
  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly author_profile_id!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly operation!: 'CREATE' | 'UPDATE';

  @Column({ type: 'varchar', length: 50, nullable: false })
  readonly deterministic_gate_version!: string;

  @Column({ type: 'char', length: 64, nullable: false })
  readonly content_fingerprint!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  readonly deterministic_signal!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly outcome!: PrePublicationCheckOutcome;

  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly evaluator_version!: string | null;

  @Column({ type: 'json', nullable: true })
  readonly evaluator_result!: Record<string, unknown> | null;

  @Index(`${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}_created_idx`)
  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}
