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

export interface DropVoteNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_VOTED;
  data: DropVoteNotificationData;
}

export interface DropReplyNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_REPLIED;
  data: DropReplyNotificationData;
}

export interface DropQuoteNotification extends UserNotificationBase {
  cause: IdentityNotificationCause.DROP_QUOTED;
  data: DropQuoteNotificationData;
}

export type UserNotification =
  | IdentitySubscriptionNotification
  | IdentityMentionNotification
  | DropVoteNotification
  | DropReplyNotification
  | DropQuoteNotification;

export interface UserNotificationsResponse {
  readonly notifications: UserNotification[];
  readonly total_unread: number;
}
