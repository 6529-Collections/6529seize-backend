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
  vote_change?: number | null;
  total_vote?: number | null;
  wave_id: string;
}

export interface DropPollVoteNotificationOption {
  option_no: number;
  option_string: string;
}

export interface DropPollVoteNotificationData {
  voter_id: string;
  drop_id: string;
  drop_author_id: string;
  poll_options: DropPollVoteNotificationOption[];
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
  wave_id: string;
}

export interface PriorityAlertNotificationData {
  additional_identity_id: string;
  drop_id: string;
  wave_id: string;
}

export interface IdentityRepNotificationData {
  rater_id: string;
  rated_id: string;
  amount: number;
  rater_rating?: number | null;
  total: number;
  category: string;
}

export interface IdentityNicNotificationData {
  rater_id: string;
  rated_id: string;
  amount: number;
  rater_rating?: number | null;
  total: number;
}

export type SubscriptionCoverageNotificationStatus =
  | 'EARLY_WARNING'
  | 'RUNNING_LOW'
  | 'ACTION_REQUIRED';

export interface SubscriptionCoverageNotificationDrop {
  token_id: number;
  mint_at: string;
}

export interface SubscriptionCoverageNotificationNextUnfunded extends SubscriptionCoverageNotificationDrop {
  requested_mints: number;
  funded_mints: number;
  missing_mints: number;
}

export interface SubscriptionCoverageNotificationData {
  recipient_profile_id: string;
  profile_handle: string;
  status: SubscriptionCoverageNotificationStatus;
  consolidation_key: string;
  mint_capacity: number;
  allocated_mints: number;
  fully_funded_drops: number;
  funded_through: SubscriptionCoverageNotificationDrop | null;
  next_unfunded: SubscriptionCoverageNotificationNextUnfunded | null;
  minimum_top_up_eth: string | null;
  top_up_deadline: string | null;
  calculation_version: number;
  forecast_fingerprint: string;
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

export interface DropPollVoteNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_POLL_VOTED;
  data: DropPollVoteNotificationData;
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

export interface SubscriptionCoverageNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE;
  data: SubscriptionCoverageNotificationData;
}

export type UserNotification =
  | IdentitySubscriptionNotification
  | IdentityMentionNotification
  | IdentityRepNotification
  | IdentityNicNotification
  | DropVoteNotification
  | DropPollVoteNotification
  | DropReactionNotification
  | DropBoostNotification
  | DropReplyNotification
  | DropQuoteNotification
  | WaveCreatedNotification
  | AllDropsNotification
  | PriorityAlertNotification
  | SubscriptionCoverageNotification;

export interface UserNotificationsResponse {
  readonly notifications: UserNotification[];
  readonly total_unread: number;
}
