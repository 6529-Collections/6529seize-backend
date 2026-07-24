import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMBERSHIP_REFRESH_REQUESTS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { MembershipRefreshScope } from '@/entities/IMembershipRefreshRequest';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { sqs } from '@/sqs';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import {
  MEMBERSHIP_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  MEMBERSHIP_DIRTY_REFRESH_QUEUE_NAME
} from './membership.constants';

export const MembershipRefreshReason = {
  RATING_CHANGED: 'RATING_CHANGED',
  NFT_OWNERSHIP_CHANGED: 'NFT_OWNERSHIP_CHANGED',
  CONSOLIDATION_CHANGED: 'CONSOLIDATION_CHANGED',
  TDH_XTDH_CHANGED: 'TDH_XTDH_CHANGED',
  GRANT_CHANGED: 'GRANT_CHANGED',
  GROUP_CHANGED: 'GROUP_CHANGED',
  PROFILE_GROUP_CHANGED: 'PROFILE_GROUP_CHANGED',
  WAVE_GROUP_CHANGED: 'WAVE_GROUP_CHANGED'
} as const;

export type MembershipRefreshReason =
  (typeof MembershipRefreshReason)[keyof typeof MembershipRefreshReason];

export const MembershipCriteriaDimension = {
  ALL: 'ALL',
  TDH_LEVEL: 'TDH_LEVEL',
  NFT_OWNERSHIP: 'NFT_OWNERSHIP',
  GRANT: 'GRANT'
} as const;

export type MembershipCriteriaDimension =
  (typeof MembershipCriteriaDimension)[keyof typeof MembershipCriteriaDimension];

const TARGET_CHUNK_SIZE = 250;

export class MembershipRefreshProducer extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public async markProfilesDirty(
    profileIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    await this.markTargetsDirty(
      MembershipRefreshScope.PROFILE,
      profileIds,
      reason,
      ctx
    );
  }

  public async markGroupsDirty(
    groupIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    await this.markTargetsDirty(
      MembershipRefreshScope.GROUP,
      groupIds,
      reason,
      ctx
    );
  }

  public async requestProfilesDirtyBestEffort(
    profileIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.markProfilesDirty(profileIds, reason, ctx);
      await this.enqueueDirtyRefreshBestEffort();
    } catch (error) {
      this.logger.error(`Failed to request profile membership refresh`, {
        profileIds,
        reason,
        error
      });
    }
  }

  public async requestGroupsDirtyBestEffort(
    groupIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.markGroupsDirty(groupIds, reason, ctx);
      await this.enqueueDirtyRefreshBestEffort();
    } catch (error) {
      this.logger.error(`Failed to request group membership refresh`, {
        groupIds,
        reason,
        error
      });
    }
  }

  public async requestProfilesForWalletsDirtyBestEffort(
    wallets: string[],
    reason: MembershipRefreshReason
  ): Promise<void> {
    try {
      await this.markProfilesForWalletsDirty(wallets, reason);
      await this.enqueueDirtyRefreshBestEffort();
    } catch (error) {
      this.logger.error(`Failed to dirty memberships for wallets`, {
        walletCount: wallets.length,
        reason,
        error
      });
    }
  }

  public async markProfilesForWalletsDirty(
    wallets: string[],
    reason: MembershipRefreshReason
  ): Promise<void> {
    const normalizedWallets = Array.from(
      new Set(wallets.map((wallet) => wallet.toLowerCase()).filter(Boolean))
    );
    if (!normalizedWallets.length) {
      return;
    }
    const profileIds = new Set<string>();
    for (
      let offset = 0;
      offset < normalizedWallets.length;
      offset += TARGET_CHUNK_SIZE
    ) {
      const walletChunk = normalizedWallets.slice(
        offset,
        offset + TARGET_CHUNK_SIZE
      );
      const rows = await this.db.execute<{ profile_id: string }>(
        `
        select distinct identities.profile_id
        from ${ADDRESS_CONSOLIDATION_KEY} consolidations
        join ${IDENTITIES_TABLE} identities
          on identities.consolidation_key = consolidations.consolidation_key
        where consolidations.address in (:wallets)
          and identities.profile_id is not null
        `,
        { wallets: walletChunk }
      );
      rows.forEach((row) => profileIds.add(row.profile_id));
    }
    await this.markProfilesDirty(Array.from(profileIds), reason);
  }

  public async requestGroupsByDimensionDirtyBestEffort(
    dimension: MembershipCriteriaDimension,
    reason: MembershipRefreshReason
  ): Promise<void> {
    try {
      await this.markGroupsByDimensionDirty(dimension, reason);
      await this.enqueueDirtyRefreshBestEffort();
    } catch (error) {
      this.logger.error(`Failed to dirty membership dimension`, {
        dimension,
        reason,
        error
      });
    }
  }

  public async markGroupsByDimensionDirty(
    dimension: MembershipCriteriaDimension,
    reason: MembershipRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    const now = Time.currentMillis();
    await this.db.execute(
      `
      insert into ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
        (scope, target_id, reason, dirty_at, attempts, last_error, created_at, updated_at)
      select
        :scope,
        community_group.id,
        :reason,
        :dirtyAt,
        0,
        null,
        :createdAt,
        :updatedAt
      from ${USER_GROUPS_TABLE} community_group
      where community_group.visible = true
        and (${this.getDimensionPredicate(dimension)})
        and (
          exists (
            select 1
            from ${WAVES_TABLE} waves
            where community_group.id in (
              waves.visibility_group_id,
              waves.admin_group_id,
              waves.chat_group_id,
              waves.participation_group_id,
              waves.voting_group_id
            )
          )
          or exists (
            select 1
            from ${WAVE_CURATIONS_TABLE} curations
            where curations.community_group_id = community_group.id
          )
        )
      on duplicate key update
        reason = values(reason),
        dirty_at = greatest(
          values(dirty_at),
          ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}.dirty_at + 1
        ),
        attempts = 0,
        last_error = null,
        updated_at = values(updated_at)
      `,
      {
        scope: MembershipRefreshScope.GROUP,
        reason,
        dirtyAt: now,
        createdAt: now,
        updatedAt: now
      },
      { wrappedConnection: ctx.connection }
    );
  }

  public async enqueueDirtyRefreshBestEffort(): Promise<void> {
    try {
      await sqs.sendToQueueName({
        queueName: MEMBERSHIP_DIRTY_REFRESH_QUEUE_NAME,
        messageGroupId: MEMBERSHIP_DIRTY_REFRESH_MESSAGE_GROUP_ID,
        message: {
          mode: 'DIRTY',
          requestedAt: Time.currentMillis(),
          nonce: randomUUID()
        }
      });
    } catch (error) {
      this.logger.error(`Failed to wake membership refresh queue`, { error });
    }
  }

  private async markTargetsDirty(
    scope: MembershipRefreshScope,
    targetIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext
  ): Promise<void> {
    const distinctTargetIds = Array.from(
      new Set(targetIds.filter((targetId) => targetId.length > 0))
    );
    for (
      let offset = 0;
      offset < distinctTargetIds.length;
      offset += TARGET_CHUNK_SIZE
    ) {
      await this.markTargetChunkDirty(
        scope,
        distinctTargetIds.slice(offset, offset + TARGET_CHUNK_SIZE),
        reason,
        ctx
      );
    }
  }

  private async markTargetChunkDirty(
    scope: MembershipRefreshScope,
    targetIds: string[],
    reason: MembershipRefreshReason,
    ctx: RequestContext
  ): Promise<void> {
    if (!targetIds.length) {
      return;
    }
    const now = Time.currentMillis();
    const params = targetIds.reduce<Record<string, string | number>>(
      (acc, targetId, index) => {
        acc[`targetId${index}`] = targetId;
        return acc;
      },
      {
        scope,
        reason,
        dirtyAt: now,
        createdAt: now,
        updatedAt: now
      }
    );
    await this.db.execute(
      `
      insert into ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}
        (scope, target_id, reason, dirty_at, attempts, last_error, created_at, updated_at)
      values ${targetIds
        .map(
          (_, index) =>
            `(:scope, :targetId${index}, :reason, :dirtyAt, 0, null, :createdAt, :updatedAt)`
        )
        .join(', ')}
      as new
      on duplicate key update
        reason = new.reason,
        dirty_at = greatest(
          new.dirty_at,
          ${MEMBERSHIP_REFRESH_REQUESTS_TABLE}.dirty_at + 1
        ),
        attempts = 0,
        last_error = null,
        updated_at = new.updated_at
      `,
      params,
      { wrappedConnection: ctx.connection }
    );
  }

  private getDimensionPredicate(
    dimension: MembershipCriteriaDimension
  ): string {
    switch (dimension) {
      case MembershipCriteriaDimension.ALL:
        return 'true';
      case MembershipCriteriaDimension.TDH_LEVEL:
        return `
          community_group.tdh_min is not null
          or community_group.tdh_max is not null
          or community_group.level_min is not null
          or community_group.level_max is not null
        `;
      case MembershipCriteriaDimension.NFT_OWNERSHIP:
        return `
          community_group.owns_meme = true
          or community_group.owns_gradient = true
          or community_group.owns_lab = true
          or community_group.owns_nextgen = true
        `;
      case MembershipCriteriaDimension.GRANT:
        return 'community_group.is_beneficiary_of_grant_id is not null';
    }
  }
}

export const membershipRefreshProducer = new MembershipRefreshProducer(
  dbSupplier
);
