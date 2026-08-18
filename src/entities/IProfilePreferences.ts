import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_PREFERENCES_TABLE } from '@/constants';

export enum ProfileDirectMessagePolicy {
  EVERYONE = 'EVERYONE',
  PEOPLE_I_FOLLOW = 'PEOPLE_I_FOLLOW',
  NOBODY = 'NOBODY'
}

export enum ProfileNotificationLevel {
  ALL = 'ALL',
  ESSENTIAL_ONLY = 'ESSENTIAL_ONLY'
}

export interface ProfileNotificationCategories {
  readonly direct_messages: boolean;
  readonly mentions_replies_quotes: boolean;
  readonly reactions_votes_boosts: boolean;
  readonly new_followers: boolean;
  readonly rep_and_nic: boolean;
  readonly subscription_coverage: boolean;
}

export interface ProfilePreferencesData {
  readonly direct_message_policy: ProfileDirectMessagePolicy;
  readonly notification_level: ProfileNotificationLevel;
  readonly notifications: ProfileNotificationCategories;
}

export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferencesData = {
  direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
  notification_level: ProfileNotificationLevel.ALL,
  notifications: {
    direct_messages: true,
    mentions_replies_quotes: true,
    reactions_votes_boosts: true,
    new_followers: true,
    rep_and_nic: true,
    subscription_coverage: true
  }
};

@Entity(PROFILE_PREFERENCES_TABLE)
export class ProfilePreferencesEntity {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  readonly profile_id!: string;

  @Column({
    type: 'varchar',
    length: 30,
    nullable: false,
    default: ProfileDirectMessagePolicy.EVERYONE
  })
  readonly direct_message_policy!: ProfileDirectMessagePolicy;

  @Column({
    type: 'varchar',
    length: 30,
    nullable: false,
    default: ProfileNotificationLevel.ALL
  })
  readonly notification_level!: ProfileNotificationLevel;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_direct_messages!: boolean;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_mentions_replies_quotes!: boolean;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_reactions_votes_boosts!: boolean;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_new_followers!: boolean;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_rep_and_nic!: boolean;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly notify_subscription_coverage!: boolean;
}
