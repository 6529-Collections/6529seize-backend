import {
  anonymousNotificationActorDropId,
  findAnonymousNotificationActorPairs,
  NotificationActorWriteOptions
} from '@/notifications/anonymous-notification-actor';
import { IDENTITY_MUTES_TABLE } from '@/constants';
import { BadRequestException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';
import { invalidateWaveUnreadCacheForReaderAfterCommit } from '@/api/waves/wave-unread-cache';

export interface IdentityMutePair {
  readonly muter_id: string;
  readonly muted_identity_id: string;
}

export class IdentityMutesDb extends LazyDbAccessCompatibleService {
  async muteIdentity(pair: IdentityMutePair, ctx: RequestContext) {
    this.assertNotSelfMute(pair);
    ctx.timer?.start(`${this.constructor.name}->muteIdentity`);
    try {
      await this.db.execute(
        `
          insert into ${IDENTITY_MUTES_TABLE} (
            muter_id,
            muted_identity_id,
            created_at
          ) values (
            :muter_id,
            :muted_identity_id,
            :created_at
          )
          on duplicate key update created_at = values(created_at)
        `,
        { ...pair, created_at: Time.currentMillis() },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      await this.invalidateUnreadSummariesForMuter(pair, ctx);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->muteIdentity`);
    }
  }

  async unmuteIdentity(pair: IdentityMutePair, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->unmuteIdentity`);
    try {
      await this.db.execute(
        `
          delete from ${IDENTITY_MUTES_TABLE}
          where muter_id = :muter_id
            and muted_identity_id = :muted_identity_id
        `,
        pair,
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      await this.invalidateUnreadSummariesForMuter(pair, ctx);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->unmuteIdentity`);
    }
  }

  async isIdentityMuted(
    pair: IdentityMutePair,
    connection?: ConnectionWrapper<any>
  ): Promise<boolean> {
    return this.db
      .oneOrNull<{ id: bigint }>(
        `
          select id
          from ${IDENTITY_MUTES_TABLE}
          where muter_id = :muter_id
            and muted_identity_id = :muted_identity_id
          limit 1
        `,
        pair,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((row) => row !== null);
  }

  async findMutedIdentityIds(
    {
      muterId,
      mutedIdentityIds
    }: {
      readonly muterId: string;
      readonly mutedIdentityIds: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    const uniqueMutedIdentityIds = Array.from(new Set(mutedIdentityIds));
    if (!uniqueMutedIdentityIds.length) {
      return [];
    }

    return this.db
      .execute<{ muted_identity_id: string }>(
        `
          select muted_identity_id
          from ${IDENTITY_MUTES_TABLE}
          where muter_id = :muterId
            and muted_identity_id in (:mutedIdentityIds)
        `,
        { muterId, mutedIdentityIds: uniqueMutedIdentityIds },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((rows) => rows.map((row) => row.muted_identity_id));
  }

  async filterMutedNotificationRows<
    T extends {
      readonly identity_id: string;
      readonly additional_identity_id: string | null;
      readonly cause?: string;
      readonly related_drop_id?: string | null;
    }
  >(
    notifications: T[],
    connection?: ConnectionWrapper<any>,
    options: NotificationActorWriteOptions = {}
  ): Promise<T[]> {
    const muterIds = new Set<string>();
    const mutedIdentityIds = new Set<string>();
    notifications.forEach((notification) => {
      const actorId = notification.additional_identity_id;
      if (actorId !== null) {
        muterIds.add(notification.identity_id);
        mutedIdentityIds.add(actorId);
      }
    });
    if (!muterIds.size || !mutedIdentityIds.size) {
      return notifications;
    }

    const mutedPairs = await this.db.execute<{
      muter_id: string;
      muted_identity_id: string;
    }>(
      `
        select muter_id, muted_identity_id
        from ${IDENTITY_MUTES_TABLE}
        where muter_id in (:muterIds)
          and muted_identity_id in (:mutedIdentityIds)
      `,
      {
        muterIds: Array.from(muterIds),
        mutedIdentityIds: Array.from(mutedIdentityIds)
      },
      connection ? { wrappedConnection: connection } : undefined
    );

    const mutedPairSet = new Set(
      mutedPairs.map((pair) => `${pair.muter_id}:${pair.muted_identity_id}`)
    );
    const anonymousActorPairs = await findAnonymousNotificationActorPairs(
      notifications.filter(
        (notification) =>
          notification.additional_identity_id !== null &&
          mutedPairSet.has(
            `${notification.identity_id}:${notification.additional_identity_id}`
          )
      ),
      this.db,
      connection,
      options
    );
    return notifications.filter((notification) => {
      const actorId = notification.additional_identity_id;
      const anonymousDropId = anonymousNotificationActorDropId(notification);
      return (
        actorId === null ||
        !mutedPairSet.has(`${notification.identity_id}:${actorId}`) ||
        (anonymousDropId !== null &&
          anonymousActorPairs.has(`${anonymousDropId}:${actorId}`))
      );
    });
  }

  private assertNotSelfMute(pair: IdentityMutePair) {
    if (pair.muter_id === pair.muted_identity_id) {
      throw new BadRequestException(`You can't mute your own profile`);
    }
  }

  /**
   * A mute hides the author's drops from the muter's unread counts in every
   * wave: one reader-wide version, bumped once the write commits.
   */
  private async invalidateUnreadSummariesForMuter(
    pair: IdentityMutePair,
    ctx: RequestContext
  ) {
    await invalidateWaveUnreadCacheForReaderAfterCommit(
      pair.muter_id,
      ctx.connection
    );
  }
}

export const identityMutesDb = new IdentityMutesDb(dbSupplier);
