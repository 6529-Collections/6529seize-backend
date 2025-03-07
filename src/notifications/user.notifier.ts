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
import { RequestContext } from '../request.context';

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
    ctx: RequestContext,
    timer: Timer
  ) {
    await Promise.all(
      identityIds.map((identityId) =>
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
    timer.stop('userNotifier->notifyOfWaveCreated');
  }

  public async notifyAllNotificationsSubscribers(
    {
      waveId,
      dropId,
      relatedIdentityId,
      subscriberIds,
      ignoreProfileIds,
      vote
    }: {
      waveId: string;
      dropId: string;
      relatedIdentityId: string;
      subscriberIds: string[];
      ignoreProfileIds?: string[];
      vote?: number;
    },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ) {
    timer.start('userNotifier->notifyAllNotificationsSubscribers');
    console.log('i am waveId', waveId);
    console.log('i am dropId', dropId);
    console.log('i am relatedIdentityId', relatedIdentityId);
    console.log('i am subscriberIds', subscriberIds);

    if (!ignoreProfileIds?.length) {
      const existingNotificationIdentities =
        await this.identityNotificationsDb.findIdentitiesNotification(
          waveId,
          dropId,
          connection
        );
      console.log(
        'i am existingNotificationIdentities',
        existingNotificationIdentities
      );
      ignoreProfileIds = existingNotificationIdentities;
    }

    const subscriberIdsToNotify = subscriberIds.filter(
      (it) => !ignoreProfileIds.includes(it) && it !== relatedIdentityId
    );
    console.log('i am subscriberIdsToNotify', subscriberIdsToNotify);
    await Promise.all(
      subscriberIdsToNotify.map(async (it) => {
        await this.identityNotificationsDb.insertNotification(
          {
            identity_id: it,
            additional_identity_id: relatedIdentityId,
            related_drop_id: dropId,
            related_drop_part_no: null,
            related_drop_2_id: null,
            related_drop_2_part_no: null,
            wave_id: waveId,
            cause: IdentityNotificationCause.ALL_DROPS,
            additional_data: { vote },
            visibility_group_id: null
          },
          connection
        );
      })
    );
    timer.stop('userNotifier->notifyAllNotificationsSubscribers');
  }
}

export const userNotifier = new UserNotifier(identityNotificationsDb);
