import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_EVALUATIONS_TABLE
} from '@/constants';
import type {
  ModerationInput,
  ModerationOutcome,
  ModerationPolicyFamily,
  ModerationSubject
} from '@/content-moderation/moderation-review.types';

@Entity(CONTENT_MODERATION_ITEMS_TABLE)
@Index('moderation_items_queue_idx', ['review_status', 'created_at', 'id'])
@Index('moderation_items_subject_idx', ['subject_type', 'subject_id'])
@Index('moderation_items_author_idx', ['author_profile_id', 'created_at'])
@Index('moderation_items_created_idx', ['created_at', 'id'])
@Index('moderation_items_published_idx', [
  'subject_type',
  'published_subject_id',
  'suppressed'
])
export class ModerationItemEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) id!: string;
  @Column({ type: 'varchar', length: 32 }) subject_type!: ModerationSubject;
  @Column({ type: 'varchar', length: 200 }) subject_id!: string;
  @Column({ type: 'varchar', length: 50, nullable: true }) author_profile_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 50, nullable: true }) actor_profile_id!:
    | string
    | null;
  @Column({ type: 'varchar', length: 32 }) operation!: string;
  @Column({ type: 'varchar', length: 32 })
  policy_family!: ModerationPolicyFamily;
  @Column({ type: 'varchar', length: 100 }) policy_version!: string;
  @Column({ type: 'char', length: 64 }) content_fingerprint!: string;
  @Column({ type: 'json' }) scope!: ModerationInput['scope'];
  @Column({ type: 'json', nullable: true }) evidence!: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'varchar', length: 16 }) outcome!: ModerationOutcome;
  @Column({ type: 'varchar', length: 64 }) trigger!: string;
  @Column({ type: 'varchar', length: 32 }) review_status!: string;
  @Column({ type: 'varchar', length: 16, nullable: true }) override!:
    | string
    | null;
  @Column({ type: 'bigint', nullable: true }) permit_expires_at!: number | null;
  @Column({ type: 'bigint', nullable: true }) permit_consumed_at!:
    | number
    | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  published_subject_id!: string | null;
  @Column({ type: 'boolean', default: false }) suppressed!: boolean;
  @Column({ type: 'int', default: 1 }) version!: number;
  @Column({ type: 'bigint' }) created_at!: number;
  @Column({ type: 'bigint' }) updated_at!: number;
  @Column({ type: 'bigint', nullable: true }) evidence_expires_at!:
    | number
    | null;
}

@Entity(CONTENT_MODERATION_EVALUATIONS_TABLE)
@Index('moderation_evaluations_item_idx', ['item_id', 'started_at'])
export class ModerationEvaluationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) id!: string;
  @Column({ type: 'char', length: 64 }) item_id!: string;
  @Column({ type: 'varchar', length: 36, nullable: true }) retry_of!:
    | string
    | null;
  @Column({ type: 'varchar', length: 64 }) trigger!: string;
  @Column({ type: 'varchar', length: 16 }) outcome!: ModerationOutcome;
  @Column({ type: 'varchar', length: 32, nullable: true }) provider!:
    | string
    | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) model!:
    | string
    | null;
  @Column({ type: 'varchar', length: 100 }) policy_version!: string;
  @Column({ type: 'json', nullable: true }) result!: Record<
    string,
    unknown
  > | null;
  @Column({ type: 'boolean', default: false }) cache_hit!: boolean;
  @Column({ type: 'varchar', length: 100, nullable: true }) fallback!:
    | string
    | null;
  @Column({ type: 'bigint' }) started_at!: number;
  @Column({ type: 'bigint', nullable: true }) completed_at!: number | null;
}
