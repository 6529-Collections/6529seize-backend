import { seizeSettings } from '../api-serverless/src/api-constants';
import { identitySubscriptionsDb } from '../api-serverless/src/identity-subscriptions/identity-subscriptions.db';
import { IdentityNotificationCause } from '../entities/IIdentityNotification';
import { RequestContext } from '../request.context';
import { ConnectionWrapper } from '../sql-executor';
import { Timer } from '../time';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from './identity-notifications.db';
import {
  DropBoostNotificationData,
  DropQuoteNotificationData,
  DropReactionNotificationData,
  DropReplyNotificationData,
  DropVoteNotificationData,
  IdentityMentionNotificationData,
  IdentitySubscriptionNotificationData
} from './user-notification.types';

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
        wave_id: null,
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
      mentioner_identity_id,
      wave_id
    }: IdentityMentionNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfIdentityMention');
    if (mentioned_identity_id !== mentioner_identity_id) {
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
          wave_id,
          visibility_group_id
        },
        connection
      );
    }
    timer.stop('userNotifier->notifyOfIdentityMention');
  }

  public async notifyOfDropVote(
    {
      voter_id,
      drop_id,
      drop_author_id,
      vote,
      wave_id
    }: DropVoteNotificationData,
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
        wave_id,
        visibility_group_id
      },
      connection
    );
  }

  public async notifyOfDropReaction(
    {
      profile_id,
      drop_id,
      drop_author_id,
      reaction,
      wave_id
    }: DropReactionNotificationData,
    visibility_group_id: string | null,
    connection?: ConnectionWrapper<any>
  ) {
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: drop_author_id,
        additional_identity_id: profile_id,
        related_drop_id: drop_id,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.DROP_REACTED,
        additional_data: { reaction },
        wave_id,
        visibility_group_id
      },
      connection
    );
  }

  public async notifyOfDropBoost(
    { booster_id, drop_id, drop_author_id, wave_id }: DropBoostNotificationData,
    visibility_group_id: string | null,
    connection?: ConnectionWrapper<any>
  ) {
    if (booster_id !== drop_author_id) {
      await this.identityNotificationsDb.insertNotification(
        {
          identity_id: drop_author_id,
          additional_identity_id: booster_id,
          related_drop_id: drop_id,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          cause: IdentityNotificationCause.DROP_BOOSTED,
          additional_data: {},
          wave_id,
          visibility_group_id
        },
        connection
      );
    }
  }

  public async notifyOfDropReply(
    {
      reply_drop_id,
      reply_drop_author_id,
      replied_drop_id,
      replied_drop_part,
      replied_drop_author_id,
      wave_id
    }: DropReplyNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfDropReply');
    if (reply_drop_author_id !== replied_drop_author_id) {
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
          wave_id,
          visibility_group_id
        },
        connection
      );
    }
    timer.stop('userNotifier->notifyOfDropReply');
  }

  public async notifyOfDropQuote(
    {
      quote_drop_id,
      quote_drop_part,
      quote_drop_author_id,
      quoted_drop_id,
      quoted_drop_part,
      quoted_drop_author_id,
      wave_id
    }: DropQuoteNotificationData,
    visibility_group_id: string | null,
    connection: ConnectionWrapper<any>,
    timer: Timer
  ) {
    timer.start('userNotifier->notifyOfDropQuote');
    if (quote_drop_author_id !== quoted_drop_author_id) {
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
          wave_id,
          visibility_group_id
        },
        connection
      );
    }
    timer.stop('userNotifier->notifyOfDropQuote');
  }

  public async notifyOfWaveCreated(
    waveId: string,
    createdBy: string,
    identityIds: string[],
    ctx: RequestContext
  ) {
    ctx.timer?.start('userNotifier->notifyOfWaveCreated');
    await Promise.all(
      identityIds
        .filter((it) => it !== createdBy)
        .map((identityId) =>
          this.identityNotificationsDb.insertNotification(
            {
              identity_id: identityId,
              additional_identity_id: createdBy,
              related_drop_id: null,
              related_drop_part_no: null,
              related_drop_2_id: null,
              related_drop_2_part_no: null,
              cause: IdentityNotificationCause.WAVE_CREATED,
              additional_data: {},
              wave_id: waveId,
              visibility_group_id: null
            },
            ctx.connection
          )
        )
    );
    ctx.timer?.stop('userNotifier->notifyOfWaveCreated');
  }

  public async notifyAllNotificationsSubscribers(
    {
      waveId,
      dropId,
      relatedIdentityId,
      subscriberIds
    }: {
      waveId: string;
      dropId: string;
      relatedIdentityId: string;
      subscriberIds: string[];
    },
    { timer, connection }: RequestContext
  ) {
    timer?.start('userNotifier->notifyAllNotificationsSubscribers');

    const waveMembersCount =
      await identitySubscriptionsDb.countWaveSubscribers(waveId);
    const subscribersLimit =
      seizeSettings().all_drops_notifications_subscribers_limit;

    if (waveMembersCount > subscribersLimit) {
      timer?.stop('userNotifier->notifyAllNotificationsSubscribers');
      return;
    }

    const existingNotificationIdentities =
      await this.identityNotificationsDb.findIdentitiesNotification(
        waveId,
        dropId,
        connection
      );

    const ignoreProfileIds = existingNotificationIdentities ?? [];

    const subscriberIdsToNotify = subscriberIds.filter(
      (id) => !ignoreProfileIds.includes(id) && id !== relatedIdentityId
    );

    await Promise.all(
      subscriberIdsToNotify.map((id) =>
        this.identityNotificationsDb.insertNotification(
          {
            identity_id: id,
            additional_identity_id: relatedIdentityId,
            related_drop_id: dropId,
            related_drop_part_no: null,
            related_drop_2_id: null,
            related_drop_2_part_no: null,
            wave_id: waveId,
            cause: IdentityNotificationCause.ALL_DROPS,
            additional_data: {},
            visibility_group_id: null
          },
          connection
        )
      )
    );

    timer?.stop('userNotifier->notifyAllNotificationsSubscribers');
  }
}

export const userNotifier = new UserNotifier(identityNotificationsDb);
