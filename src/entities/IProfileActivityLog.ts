import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '../constants';

@Entity(PROFILES_ACTIVITY_LOGS_TABLE)
export class ProfileActivityLog {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly target_id!: string | null;

  @Column({ type: 'json' })
  readonly contents!: string;

  @Column({ type: 'varchar', length: 256 })
  readonly type!: ProfileActivityLogType;

  @Column({ type: 'datetime', nullable: true, default: null })
  readonly created_at!: Date;
}

export enum ProfileActivityLogType {
  RATING_EDIT = 'RATING_EDIT',
  PROXY_RATING_EDIT = 'PROXY_RATING_EDIT',
  PROXY_DROP_RATING_EDIT = 'PROXY_DROP_RATING_EDIT',
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
  DROP_RATING_EDIT = 'DROP_RATING_EDIT',
  DROP_CREATED = 'DROP_CREATED',
  DROP_VOTED = 'DROP_VOTED'
}

export function isTargetOfTypeDrop(type: ProfileActivityLogType): boolean {
  return [
    ProfileActivityLogType.DROP_CREATED,
    ProfileActivityLogType.DROP_RATING_EDIT,
    ProfileActivityLogType.DROP_COMMENT,
    ProfileActivityLogType.PROXY_DROP_RATING_EDIT
  ].includes(type);
}
