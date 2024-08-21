import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from './identity-notifications.db';
import { ConnectionWrapper } from '../sql-executor';
import { IdentityNotificationCause } from '../entities/IIdentityNotification';
import {
  DropQuoteNotificationData,
  DropReplyNotificationData,
  DropVoteNotificationData,
  IdentityMentionNotificationData,
  IdentitySubscriptionNotificationData
} from './user-notification.types';
import { Timer } from '../time';

export class UserNotifier {
  constructor(
    private readonly identityNotificationsDb: IdentityNotificationsDb
  ) {}

  public async notifyOfIdentitySubscription(
    { subscriber_id, subscribed_to }: IdentitySubscriptionNotificationData,
    connection?: ConnectionWrapper<any>
  ) {
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: subscribed_to,
        additional_identity_id: subscriber_id,
        related_drop_id: null,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
        additional_data: {},
        visibility_group_id: null
      },
      connection
    );
  }

  public async notifyOfIdentityMention(
    {
      mentioned_identity_id,
      drop_id,
      mentioner_identity_id
    }: IdentityMentionNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfIdentityMention');
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: mentioned_identity_id,
        additional_identity_id: mentioner_identity_id,
        related_drop_id: drop_id,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.IDENTITY_MENTIONED,
        additional_data: {},
        visibility_group_id
      },
      connection
    );
    timer.stop('userNotifier->notifyOfIdentityMention');
  }

  public async notifyOfDropVote(
    { voter_id, drop_id, drop_author_id, vote }: DropVoteNotificationData,
    visibility_group_id: string | null,
    connection?: ConnectionWrapper<any>
  ) {
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: drop_author_id,
        additional_identity_id: voter_id,
        related_drop_id: drop_id,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.DROP_VOTED,
        additional_data: { vote },
        visibility_group_id
      },
      connection
    );
  }

  public async notifyOfDropReply(
    {
      reply_drop_id,
      reply_drop_author_id,
      replied_drop_id,
      replied_drop_part,
      replied_drop_author_id
    }: DropReplyNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfDropReply');
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: replied_drop_author_id,
        additional_identity_id: reply_drop_author_id,
        related_drop_id: reply_drop_id,
        related_drop_part_no: null,
        related_drop_2_id: replied_drop_id,
        related_drop_2_part_no: replied_drop_part,
        cause: IdentityNotificationCause.DROP_REPLIED,
        additional_data: {},
        visibility_group_id
      },
      connection
    );
    timer.stop('userNotifier->notifyOfDropReply');
  }

  public async notifyOfDropQuote(
    {
      quote_drop_id,
      quote_drop_part,
      quote_drop_author_id,
      quoted_drop_id,
      quoted_drop_part,
      quoted_drop_author_id
    }: DropQuoteNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfDropQuote');
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: quoted_drop_author_id,
        additional_identity_id: quote_drop_author_id,
        related_drop_id: quote_drop_id,
        related_drop_part_no: quote_drop_part,
        related_drop_2_id: quoted_drop_id,
        related_drop_2_part_no: quoted_drop_part,
        cause: IdentityNotificationCause.DROP_QUOTED,
        additional_data: {},
        visibility_group_id
      },
      connection
    );
    timer.stop('userNotifier->notifyOfDropQuote');
  }
}

export const userNotifier = new UserNotifier(identityNotificationsDb);
