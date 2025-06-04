import { IdentityNotificationCause } from '../entities/IIdentityNotification';
import {
  AllDropsNotification,
  DropQuoteNotification,
  DropReactionNotification,
  DropReplyNotification,
  DropVoteNotification,
  IdentityMentionNotification,
  IdentitySubscriptionNotification,
  UserNotification,
  WaveCreatedNotification
} from './user-notification.types';
import { IdentityNotificationDeserialized } from './identity-notifications.db';
import { assertUnreachable } from '../assertions';
import { numbers } from '../numbers';

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
      case IdentityNotificationCause.DROP_REACTED:
        return this.mapDropReactionNotification(entity);
      case IdentityNotificationCause.DROP_REPLIED:
        return this.mapDropReplyNotification(entity);
      case IdentityNotificationCause.DROP_QUOTED:
        return this.mapDropQuoteNotification(entity);
      case IdentityNotificationCause.WAVE_CREATED:
        return this.mapWaveCreatedNotification(entity);
      case IdentityNotificationCause.ALL_DROPS:
        return this.mapAllDropsNotification(entity);
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
        vote: numbers.parseIntOrNull(entity.additional_data.vote)!,
        wave_id: entity.wave_id!
      }
    };
  }

  private mapDropReactionNotification(
    entity: IdentityNotificationDeserialized
  ): DropReactionNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.DROP_REACTED,
      data: {
        profile_id: entity.additional_identity_id!,
        drop_author_id: entity.identity_id,
        drop_id: entity.related_drop_id!,
        reaction: entity.additional_data.reaction,
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

  private mapWaveCreatedNotification(
    entity: IdentityNotificationDeserialized
  ): WaveCreatedNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.WAVE_CREATED,
      data: {
        wave_id: entity.wave_id!,
        created_by: entity.additional_identity_id!
      }
    };
  }

  private mapAllDropsNotification(
    entity: IdentityNotificationDeserialized
  ): AllDropsNotification {
    return {
      id: entity.id,
      created_at: entity.created_at,
      read_at: entity.read_at,
      cause: IdentityNotificationCause.ALL_DROPS,
      data: {
        additional_identity_id: entity.additional_identity_id!,
        drop_id: entity.related_drop_id!,
        vote: numbers.parseIntOrNull(entity.additional_data.vote)!
      }
    };
  }
}

export const userNotificationsMapper: UserNotificationMapper =
  new UserNotificationMapper();
