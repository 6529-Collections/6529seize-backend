import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_PREFERENCES_TABLE } from '@/constants';

export enum ProfileDirectMessagePolicy {
  EVERYONE = 'EVERYONE',
  PEOPLE_I_FOLLOW = 'PEOPLE_I_FOLLOW',
  NOBODY = 'NOBODY',
  /**
   * Members of the user group stored in `direct_message_group_id`. A missing
   * or hidden group fails closed to `PEOPLE_I_FOLLOW`.
   */
  GROUP_MEMBERS = 'GROUP_MEMBERS'
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
  /** Group whose members may start a new DM under `GROUP_MEMBERS`. */
  readonly direct_message_group_id: string | null;
  /** Under `GROUP_MEMBERS`, people the recipient follows are always admitted. */
  readonly direct_message_allow_people_i_follow: boolean;
  readonly notification_level: ProfileNotificationLevel;
  readonly notifications: ProfileNotificationCategories;
}

export interface ProfilePreferencesUpdate {
  readonly direct_message_policy?: ProfileDirectMessagePolicy;
  readonly direct_message_group_id?: string | null;
  readonly direct_message_allow_people_i_follow?: boolean;
  readonly notification_level?: ProfileNotificationLevel;
  readonly notifications?: Partial<ProfileNotificationCategories>;
}

export const DEFAULT_PROFILE_PREFERENCES: ProfilePreferencesData = {
  direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
  direct_message_group_id: null,
  direct_message_allow_people_i_follow: true,
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

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  readonly direct_message_group_id!: string | null;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly direct_message_allow_people_i_follow!: boolean;

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
