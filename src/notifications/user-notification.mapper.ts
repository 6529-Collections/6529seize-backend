import { IdentityNotificationCause } from '../entities/IIdentityNotification';
import {
  DropQuoteNotification,
  DropReplyNotification,
  DropVoteNotification,
  IdentityMentionNotification,
  IdentitySubscriptionNotification,
  UserNotification
} from './user-notification.types';
import { IdentityNotificationDeserialized } from './identity-notifications.db';
import { assertUnreachable, parseIntOrNull } from '../helpers';

export class UserNotificationMapper {
  public mapNotifications(
    entities: IdentityNotificationDeserialized[]
  ): UserNotification[] {
    return entities.map((it) => this.entityToNotification(it));
  }

  private entityToNotification(
    entity: IdentityNotificationDeserialized
  ): UserNotification {
    const cause = entity.cause;
    switch (cause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
        return this.mapIdentitySubscriptionNotification(entity);
      case IdentityNotificationCause.IDENTITY_MENTIONED:
        return this.mapIdentityMentionNotification(entity);
      case IdentityNotificationCause.DROP_VOTED:
        return this.mapDropVoteNotification(entity);
      case IdentityNotificationCause.DROP_REPLIED:
        return this.mapDropReplyNotification(entity);
      case IdentityNotificationCause.DROP_QUOTED:
        return this.mapDropQuoteNotification(entity);
      default: {
        return assertUnreachable(cause);
      }
    }
  }

  private mapIdentitySubscriptionNotification(
    entity: IdentityNotificationDeserialized
  ): IdentitySubscriptionNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
      data: {
        subscriber_id: entity.additional_identity_id!,
        subscribed_to: entity.identity_id
      }
    };
  }

  private mapIdentityMentionNotification(
    entity: IdentityNotificationDeserialized
  ): IdentityMentionNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.IDENTITY_MENTIONED,
      data: {
        mentioned_identity_id: entity.identity_id,
        drop_id: entity.related_drop_id!,
        mentioner_identity_id: entity.additional_identity_id!,
        wave_id: entity.wave_id!
      }
    };
  }

  private mapDropVoteNotification(
    entity: IdentityNotificationDeserialized
  ): DropVoteNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.DROP_VOTED,
      data: {
        drop_author_id: entity.identity_id,
        drop_id: entity.related_drop_id!,
        voter_id: entity.additional_identity_id!,
        vote: parseIntOrNull(entity.additional_data.vote)!,
        wave_id: entity.wave_id!
      }
    };
  }

  private mapDropReplyNotification(
    entity: IdentityNotificationDeserialized
  ): DropReplyNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.DROP_REPLIED,
      data: {
        replied_drop_author_id: entity.identity_id,
        reply_drop_author_id: entity.additional_identity_id!,
        reply_drop_id: entity.related_drop_id!,
        replied_drop_id: entity.related_drop_2_id!,
        replied_drop_part: entity.related_drop_2_part_no!,
        wave_id: entity.wave_id!
      }
    };
  }

  private mapDropQuoteNotification(
    entity: IdentityNotificationDeserialized
  ): DropQuoteNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.DROP_QUOTED,
      data: {
        quoted_drop_author_id: entity.identity_id,
        quote_drop_author_id: entity.additional_identity_id!,
        quote_drop_id: entity.related_drop_id!,
        quote_drop_part: entity.related_drop_part_no!,
        quoted_drop_id: entity.related_drop_2_id!,
        quoted_drop_part: entity.related_drop_2_part_no!,
        wave_id: entity.wave_id!
      }
    };
  }
}

export const userNotificationsMapper: UserNotificationMapper =
  new UserNotificationMapper();
