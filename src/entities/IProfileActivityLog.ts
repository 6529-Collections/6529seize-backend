import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';

@Entity(PROFILES_ACTIVITY_LOGS_TABLE)
@Index(['profile_id', 'additional_data_1', 'type', 'created_at'])
@Index(['proxy_id', 'additional_data_1', 'type', 'created_at'])
@Index(['target_id', 'additional_data_1', 'type', 'created_at'])
@Index('idx_pal_profile_type_created_at', ['profile_id', 'type', 'created_at'])
@Index('idx_pal_proxy_type_created_at', ['proxy_id', 'type', 'created_at'])
@Index('idx_pal_target_type_created_at', ['target_id', 'type', 'created_at'])
export class ProfileActivityLog {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Index()
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly target_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly proxy_id!: string | null;

  @Column({ type: 'json' })
  readonly contents!: string;

  @Index()
  @Column({ type: 'varchar', length: 256 })
  readonly type!: ProfileActivityLogType;

  @Index()
  @Column({ type: 'varchar', length: 256, nullable: true, default: null })
  readonly additional_data_1!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 256, nullable: true, default: null })
  readonly additional_data_2!: string | null;

  @Index()
  @Column({ type: 'datetime', nullable: true, default: null })
  readonly created_at!: Date;
}

export enum ProfileActivityLogType {
  RATING_EDIT = 'RATING_EDIT',
  HANDLE_EDIT = 'HANDLE_EDIT',
  CLASSIFICATION_EDIT = 'CLASSIFICATION_EDIT',
  SOCIALS_EDIT = 'SOCIALS_EDIT',
  CONTACTS_EDIT = 'CONTACTS_EDIT',
  SOCIAL_VERIFICATION_POST_EDIT = 'SOCIAL_VERIFICATION_POST_EDIT',
  NFT_ACCOUNTS_EDIT = 'NFT_ACCOUNTS_EDIT',
  GENERAL_CIC_STATEMENT_EDIT = 'GENERAL_CIC_STATEMENT_EDIT',
  BANNER_1_EDIT = 'BANNER_1_EDIT',
  BANNER_2_EDIT = 'BANNER_2_EDIT',
  PFP_EDIT = 'PFP_EDIT',
  PROFILE_ARCHIVED = 'PROFILE_ARCHIVED',
  PROXY_CREATED = 'PROXY_CREATED',
  PROXY_ACTION_CREATED = 'PROXY_ACTION_CREATED',
  PROXY_ACTION_STATE_CHANGED = 'PROXY_ACTION_STATE_CHANGED',
  PROXY_ACTION_CHANGED = 'PROXY_ACTION_CHANGED',
  DROP_COMMENT = 'DROP_COMMENT',
  DROP_VOTE_EDIT = 'DROP_VOTE_EDIT',
  DROP_CREATED = 'DROP_CREATED',
  DROP_CLAPPED = 'DROP_CLAPPED',
  DROP_REACTED = 'DROP_REACTED',
  PROFILE_CREATED = 'PROFILE_CREATED'
}

export const DROP_LOG_TYPES = [
  ProfileActivityLogType.DROP_CREATED,
  ProfileActivityLogType.DROP_VOTE_EDIT,
  ProfileActivityLogType.DROP_CLAPPED,
  ProfileActivityLogType.DROP_COMMENT
];

export function isTargetOfTypeDrop(type: ProfileActivityLogType): boolean {
  return DROP_LOG_TYPES.includes(type);
}
