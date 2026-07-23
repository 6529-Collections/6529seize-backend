import { IdentityNotificationCause } from '../entities/IIdentityNotification';
import { RequestContext } from '../request.context';
import { ConnectionWrapper } from '../sql-executor';
import { Timer } from '../time';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from './identity-notifications.db';
import type { NewIdentityNotification } from './identity-notifications.db';
import {
  DropBoostNotificationData,
  DropPollVoteNotificationData,
  DropQuoteNotificationData,
  DropReactionNotificationData,
  DropReplyNotificationData,
  DropVoteNotificationData,
  IdentityMentionNotificationData,
  IdentityNicNotificationData,
  IdentityRepNotificationData,
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

  public async notifyOfIdentityRep(
    {
      rater_id,
      rated_id,
      amount,
      rater_rating,
      total,
      category
    }: IdentityRepNotificationData,
    connection?: ConnectionWrapper<any>
  ) {
    if (rater_id !== rated_id) {
      await this.identityNotificationsDb.insertNotification(
        {
          identity_id: rated_id,
          additional_identity_id: rater_id,
          related_drop_id: null,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          wave_id: null,
          cause: IdentityNotificationCause.IDENTITY_REP,
          additional_data: { amount, rater_rating, total, category },
          visibility_group_id: null
        },
        connection
      );
    }
  }

  public async notifyOfIdentityNic(
    {
      rater_id,
      rated_id,
      amount,
      rater_rating,
      total
    }: IdentityNicNotificationData,
    connection?: ConnectionWrapper<any>
  ) {
    if (rater_id !== rated_id) {
      await this.identityNotificationsDb.insertNotification(
        {
          identity_id: rated_id,
          additional_identity_id: rater_id,
          related_drop_id: null,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          wave_id: null,
          cause: IdentityNotificationCause.IDENTITY_NIC,
          additional_data: { amount, rater_rating, total },
          visibility_group_id: null
        },
        connection
      );
    }
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
    timer?: Timer
  ) {
    timer?.start('userNotifier->notifyOfIdentityMention');
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
    timer?.stop('userNotifier->notifyOfIdentityMention');
  }

  public async notifyOfDropVote(
    {
      voter_id,
      drop_id,
      drop_author_id,
      vote,
      vote_change,
      total_vote,
      wave_id
    }: DropVoteNotificationData,
    visibility_group_id: string | null,
    connection?: ConnectionWrapper<any>
  ) {
    if (voter_id === drop_author_id) {
      return;
    }
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: drop_author_id,
        additional_identity_id: voter_id,
        related_drop_id: drop_id,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.DROP_VOTED,
        additional_data: { vote, vote_change, total_vote },
        wave_id,
        visibility_group_id
      },
      connection
    );
  }

  public async notifyOfDropPollVote(
    {
      voter_id,
      drop_id,
      drop_author_id,
      poll_options,
      wave_id
    }: DropPollVoteNotificationData,
    visibility_group_id: string | null,
    connection?: ConnectionWrapper<any>
  ) {
    if (voter_id === drop_author_id) {
      return;
    }
    await this.identityNotificationsDb.insertNotification(
      {
        identity_id: drop_author_id,
        additional_identity_id: voter_id,
        related_drop_id: drop_id,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        cause: IdentityNotificationCause.DROP_POLL_VOTED,
        additional_data: { poll_options },
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

  public async notifyWaveDropCreatedRecipients(
    {
      waveId,
      dropId,
      relatedIdentityId,
      replyNotification,
      quoteNotifications,
      mentionedIdentityIds,
      allDropsSubscriberIds
    }: {
      waveId: string;
      dropId: string;
      relatedIdentityId: string;
      replyNotification: DropReplyNotificationData | null;
      quoteNotifications: readonly DropQuoteNotificationData[];
      mentionedIdentityIds: string[];
      allDropsSubscriberIds: string[];
    },
    visibility_group_id: string | null,
    { timer, connection }: RequestContext
  ): Promise<number[]> {
    timer?.start('userNotifier->notifyWaveDropCreatedRecipients');
    const alreadyNotifiedIdentityIds = new Set(
      await this.identityNotificationsDb.findIdentitiesNotifiedForDropCreation(
        waveId,
        dropId,
        connection
      )
    );
    const notifications = this.buildDropCreationNotifications({
      waveId,
      dropId,
      relatedIdentityId,
      visibilityGroupId: visibility_group_id,
      replyNotification,
      quoteNotifications,
      mentionedIdentityIds,
      allDropsSubscriberIds,
      alreadyNotifiedIdentityIds
    });
    const pendingPushNotificationIds =
      await this.identityNotificationsDb.insertManyNotifications(
        notifications,
        connection
      );
    timer?.stop('userNotifier->notifyWaveDropCreatedRecipients');
    return pendingPushNotificationIds;
  }

  private buildDropCreationNotifications({
    waveId,
    dropId,
    relatedIdentityId,
    visibilityGroupId,
    replyNotification,
    quoteNotifications,
    mentionedIdentityIds,
    allDropsSubscriberIds,
    alreadyNotifiedIdentityIds
  }: {
    waveId: string;
    dropId: string;
    relatedIdentityId: string;
    visibilityGroupId: string | null;
    replyNotification: DropReplyNotificationData | null;
    quoteNotifications: readonly DropQuoteNotificationData[];
    mentionedIdentityIds: readonly string[];
    allDropsSubscriberIds: readonly string[];
    alreadyNotifiedIdentityIds: ReadonlySet<string>;
  }): NewIdentityNotification[] {
    const notificationsByRecipient = new Map<string, NewIdentityNotification>();
    const addNotification = (
      recipientId: string,
      notification: NewIdentityNotification
    ) => {
      if (
        recipientId === relatedIdentityId ||
        alreadyNotifiedIdentityIds.has(recipientId) ||
        notificationsByRecipient.has(recipientId)
      ) {
        return;
      }
      notificationsByRecipient.set(recipientId, notification);
    };

    // Insertion order defines the product precedence for a new drop:
    // reply > quote > mention > all-drops subscription.
    if (replyNotification) {
      addNotification(replyNotification.replied_drop_author_id, {
        identity_id: replyNotification.replied_drop_author_id,
        additional_identity_id: replyNotification.reply_drop_author_id,
        related_drop_id: replyNotification.reply_drop_id,
        related_drop_part_no: null,
        related_drop_2_id: replyNotification.replied_drop_id,
        related_drop_2_part_no: replyNotification.replied_drop_part,
        cause: IdentityNotificationCause.DROP_REPLIED,
        additional_data: {},
        wave_id: replyNotification.wave_id,
        visibility_group_id: visibilityGroupId
      });
    }
    for (const quoteNotification of quoteNotifications) {
      addNotification(quoteNotification.quoted_drop_author_id, {
        identity_id: quoteNotification.quoted_drop_author_id,
        additional_identity_id: quoteNotification.quote_drop_author_id,
        related_drop_id: quoteNotification.quote_drop_id,
        related_drop_part_no: quoteNotification.quote_drop_part,
        related_drop_2_id: quoteNotification.quoted_drop_id,
        related_drop_2_part_no: quoteNotification.quoted_drop_part,
        cause: IdentityNotificationCause.DROP_QUOTED,
        additional_data: {},
        wave_id: quoteNotification.wave_id,
        visibility_group_id: visibilityGroupId
      });
    }
    for (const mentionedIdentityId of mentionedIdentityIds) {
      addNotification(mentionedIdentityId, {
        identity_id: mentionedIdentityId,
        additional_identity_id: relatedIdentityId,
        related_drop_id: dropId,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        wave_id: waveId,
        cause: IdentityNotificationCause.IDENTITY_MENTIONED,
        additional_data: {},
        visibility_group_id: visibilityGroupId
      });
    }
    for (const subscriberId of allDropsSubscriberIds) {
      addNotification(subscriberId, {
        identity_id: subscriberId,
        additional_identity_id: relatedIdentityId,
        related_drop_id: dropId,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        wave_id: waveId,
        cause: IdentityNotificationCause.ALL_DROPS,
        additional_data: {},
        visibility_group_id: visibilityGroupId
      });
    }
    return Array.from(notificationsByRecipient.values());
  }
}

export const userNotifier = new UserNotifier(identityNotificationsDb);
