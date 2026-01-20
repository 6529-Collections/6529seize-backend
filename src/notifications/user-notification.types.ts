import { IdentityNotificationCause } from '../entities/IIdentityNotification';

export interface IdentitySubscriptionNotificationData {
  subscriber_id: string;
  subscribed_to: string;
}

export interface IdentityMentionNotificationData {
  mentioned_identity_id: string;
  drop_id: string;
  mentioner_identity_id: string;
  wave_id: string;
}

export interface DropVoteNotificationData {
  voter_id: string;
  drop_id: string;
  drop_author_id: string;
  vote: number;
  wave_id: string;
}

export interface DropReactionNotificationData {
  profile_id: string;
  drop_id: string;
  drop_author_id: string;
  reaction: string;
  wave_id: string;
}

export interface DropBoostNotificationData {
  booster_id: string;
  drop_id: string;
  drop_author_id: string;
  wave_id: string;
}

export interface DropReplyNotificationData {
  reply_drop_id: string;
  reply_drop_author_id: string;
  replied_drop_id: string;
  replied_drop_part: number;
  replied_drop_author_id: string;
  wave_id: string;
}

export interface DropQuoteNotificationData {
  quote_drop_id: string;
  quote_drop_part: number;
  quote_drop_author_id: string;
  quoted_drop_id: string;
  quoted_drop_part: number;
  quoted_drop_author_id: string;
  wave_id: string;
}

export interface WaveCreatedNotificationData {
  wave_id: string;
  created_by: string;
}

export interface AllDropsNotificationData {
  additional_identity_id: string;
  drop_id: string;
  vote: number;
}

export interface PriorityAlertNotificationData {
  additional_identity_id: string;
  drop_id: string;
}

export interface IdentityRepNotificationData {
  rater_id: string;
  rated_id: string;
  amount: number;
  total: number;
  category: string;
}

export interface IdentityNicNotificationData {
  rater_id: string;
  rated_id: string;
  amount: number;
  total: number;
}

export interface UserNotificationBase {
  id: number;
  created_at: number;
  read_at: number | null;
}

export interface IdentitySubscriptionNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED;
  data: IdentitySubscriptionNotificationData;
}

export interface IdentityMentionNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.IDENTITY_MENTIONED;
  data: IdentityMentionNotificationData;
}

export interface IdentityRepNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.IDENTITY_REP;
  data: IdentityRepNotificationData;
}

export interface IdentityNicNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.IDENTITY_NIC;
  data: IdentityNicNotificationData;
}

export interface DropVoteNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_VOTED;
  data: DropVoteNotificationData;
}

export interface DropReactionNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_REACTED;
  data: DropReactionNotificationData;
}

export interface DropBoostNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_BOOSTED;
  data: DropBoostNotificationData;
}

export interface DropReplyNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_REPLIED;
  data: DropReplyNotificationData;
}

export interface DropQuoteNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_QUOTED;
  data: DropQuoteNotificationData;
}

export interface WaveCreatedNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.WAVE_CREATED;
  data: WaveCreatedNotificationData;
}

export interface AllDropsNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.ALL_DROPS;
  data: AllDropsNotificationData;
}

export interface PriorityAlertNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.PRIORITY_ALERT;
  data: PriorityAlertNotificationData;
}

export type UserNotification =
  | IdentitySubscriptionNotification
  | IdentityMentionNotification
  | IdentityRepNotification
  | IdentityNicNotification
  | DropVoteNotification
  | DropReactionNotification
  | DropBoostNotification
  | DropReplyNotification
  | DropQuoteNotification
  | WaveCreatedNotification
  | AllDropsNotification
  | PriorityAlertNotification;

export interface UserNotificationsResponse {
  readonly notifications: UserNotification[];
  readonly total_unread: number;
}
