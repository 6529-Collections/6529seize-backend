import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { NftLinkEntity } from '@/entities/INftLink';
import { RequestContext } from '@/request.context';
import { NFT_LINKS_TABLE } from '@/constants';
import { Time } from '@/time';
import type { CanonicalLink, NormalizedNftCard } from '@/nft-links/types';
import {
  isNftLinkRefreshDue,
  type NftLinkPageRetryState
} from './nft-link-page-retry';
import { DbPoolName } from '@/db-query.options';
import {
  createPreviewLease,
  isPreviewLease,
  isPreviewSizeCooldownActive,
  PreviewCompletionFence
} from './nft-preview-size-policy';

const PREVIEW_DB_NOW =
  'cast(unix_timestamp(current_timestamp(3)) * 1000 as unsigned)';
import type {
  NftLinkMediaPreviewKind,
  NftLinkMediaPreviewStatus
} from '@/nft-links/nft-link-media-preview.types';

export class NftLinkResolutionLockLostError extends Error {
  constructor() {
    super('NFT link resolution lock is no longer owned');
    Object.setPrototypeOf(this, NftLinkResolutionLockLostError.prototype);
  }
}

export class NftLinksDb extends LazyDbAccessCompatibleService {
  public async findByCanonicalIdForNotification(
    canonicalId: string,
    ctx: RequestContext
  ): Promise<NftLinkEntity | null> {
    const timerName = `${this.constructor.name}->findByCanonicalIdForNotification`;
    ctx.timer?.start(timerName);
    try {
      const row = await this.db.oneOrNull<NftLinkEntity>(
        `select /*+ MAX_EXECUTION_TIME(3000) */ * from ${NFT_LINKS_TABLE}
         where canonical_id = :canonicalId`,
        { canonicalId },
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return this.deserializeDullData(row);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findByCanonicalId(
    canonicalId: string,
    ctx: RequestContext
  ): Promise<NftLinkEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findByCanonicalId`);
      return this.db
        .oneOrNull<NftLinkEntity>(
          `select * from ${NFT_LINKS_TABLE} where canonical_id = :canonicalId`,
          { canonicalId },
          { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
        )
        .then((res) => this.deserializeDullData(res));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findByCanonicalId`);
    }
  }

  public async findByCanonicalIds(
    canonicalIds: string[],
    ctx: RequestContext
  ): Promise<NftLinkEntity[]> {
    if (!canonicalIds.length) {
      return [];
    }
    try {
      ctx.timer?.start(`${this.constructor.name}->findByCanonicalIds`);
      return this.db
        .execute<NftLinkEntity>(
          `select * from ${NFT_LINKS_TABLE} where canonical_id in (:canonicalIds)`,
          { canonicalIds },
          { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
        )
        .then((res) => res.map((it) => this.deserializeDullData(it)!));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findByCanonicalIds`);
    }
  }

  private deserializeDullData(res: NftLinkEntity | null) {
    if (res?.full_data) {
      return {
        ...res,
        full_data: JSON.parse(res.full_data as unknown as string)
      };
    }
    return res;
  }

  public async lockForProcessing(
    {
      canonical,
      lockTTL,
      updateMinInterval
    }: {
      canonical: CanonicalLink;
      lockTTL: Time;
      updateMinInterval: Time;
    },
    ctx: RequestContext
  ): Promise<NftLinkEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->lockForProcessing`);
      return await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
          const canonicalId = canonical.canonicalId;
          const now = Time.currentMillis();
          const entity = await this.db
            .oneOrNull<NftLinkEntity>(
              `
          select * from ${NFT_LINKS_TABLE} 
          where canonical_id = :canonicalId
          and ifnull(is_locked_since, 0) < :lockedSince
          and ifnull(last_tried_to_update, 0) < :maxLastUpdated
          for update skip locked
          `,
              {
                canonicalId,
                lockedSince: now - lockTTL.toMillis(),
                maxLastUpdated: now - updateMinInterval.toMillis()
              },
              { wrappedConnection: connection }
            )
            .then((res) => this.deserializeDullData(res));
          if (
            entity &&
            isNftLinkRefreshDue(
              entity,
              canonical,
              now,
              updateMinInterval.toMillis()
            )
          ) {
            await this.db.execute(
              `
            update ${NFT_LINKS_TABLE} 
            set is_locked_since = :now
            where canonical_id = :canonicalId
            `,
              { now, canonicalId },
              { wrappedConnection: connection }
            );
            return { ...entity, is_locked_since: now };
          }
          return null;
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->lockForProcessing`);
    }
  }

  public async insertPendingOrDoNothing(
    link: Omit<
      NftLinkEntity,
      | 'last_error_message'
      | 'price'
      | 'price_currency'
      | 'full_data'
      | 'refresh_retry_state'
      | 'media_uri'
      | 'media_preview_status'
      | 'media_preview_kind'
      | 'media_preview_source_hash'
      | 'media_preview_card_url'
      | 'media_preview_thumb_url'
      | 'media_preview_small_url'
      | 'media_preview_width'
      | 'media_preview_height'
      | 'media_preview_mime_type'
      | 'media_preview_bytes'
      | 'media_preview_last_tried_at'
      | 'media_preview_last_success_at'
      | 'media_preview_failed_since'
      | 'media_preview_error_message'
      | 'media_preview_locked_since'
      | 'last_successfully_updated'
      | 'last_tried_to_update'
      | 'failed_since'
      | 'is_locked_since'
    >,
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->insert`);
      await this.db.execute(
        `
            insert into ${NFT_LINKS_TABLE} (
              canonical_id,
              platform,
              chain,
              contract,
              token,
              custom_id,
              last_tried_to_update
            ) values (
              :canonical_id,
              :platform,
              :chain,
              :contract,
              :token,
              :custom_id,
               0
            ) on duplicate key update canonical_id = :canonical_id
        `,
        link,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insert`);
    }
  }

  async updateWithFailure(
    {
      canonicalId,
      message,
      lockStamp,
      attemptedAt,
      retryState
    }: {
      canonicalId: string;
      message: string;
      lockStamp: number;
      attemptedAt: number;
      retryState: NftLinkPageRetryState | null;
    },
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateWithFailure`);
      const result = await this.db.execute(
        `
            update ${NFT_LINKS_TABLE} 
              set 
                last_tried_to_update = :now,
                last_error_message = :message,
                refresh_retry_state = :retryState,
                is_locked_since = null,
                failed_since = ifnull(failed_since, :now)
            where canonical_id = :canonicalId and is_locked_since = :lockStamp
        `,
        {
          canonicalId,
          message,
          now: attemptedAt,
          lockStamp,
          retryState: retryState ? JSON.stringify(retryState) : null
        },
        { wrappedConnection: ctx.connection }
      );
      if (this.db.getAffectedRows(result) !== 1)
        throw new NftLinkResolutionLockLostError();
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWithFailure`);
    }
  }

  async updateWithSuccess(
    data: NormalizedNftCard,
    lockStamp: number,
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateWithSuccess`);
      const identifiers = data.identifier.identifiers as any;
      const price = data.market.price?.amount ?? null;
      const price_currency =
        data.market.price?.currency ??
        (data.market.price?.amount != null ? 'ETH' : null);
      const media = data.asset.media;
      const media_uri =
        media?.kind === 'animation'
          ? (media.animationUrl ?? media.imageUrl ?? null)
          : (media?.imageUrl ?? media?.animationUrl ?? null);
      const result = await this.db.execute(
        `
            update ${NFT_LINKS_TABLE} 
              set 
                last_tried_to_update = :now,
                last_successfully_updated = :now,
                last_error_message = null,
                refresh_retry_state = null,
                is_locked_since = null,
                failed_since = null,
                full_data = :fullData,
                platform = :platform,
                chain = :chain,
                contract = :contract,
                token = :token,
                custom_id = :custom_id,
                media_uri = :media_uri,
                price = :price,
                price_currency = :price_currency
            where canonical_id = :canonicalId and is_locked_since = :lockStamp
        `,
        {
          canonicalId: data.identifier.canonicalId,
          lockStamp,
          platform: data.identifier.platform,
          chain: identifiers.chain ?? null,
          contract: identifiers.contract ?? null,
          token: identifiers.tokenId ?? null,
          custom_id:
            identifiers.instanceSlug ??
            identifiers.instanceId ??
            identifiers.appId ??
            null,
          media_uri,
          fullData: JSON.stringify(data),
          now: Time.currentMillis(),
          price,
          price_currency
        },
        { wrappedConnection: ctx.connection }
      );
      if (this.db.getAffectedRows(result) !== 1)
        throw new NftLinkResolutionLockLostError();
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWithSuccess`);
    }
  }

  public async markMediaPreviewPendingIfNeeded(
    {
      canonicalId,
      sourceHash,
      kind,
      maxBytes
    }: {
      canonicalId: string;
      sourceHash: string;
      kind: NftLinkMediaPreviewKind;
      maxBytes: number;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->markMediaPreviewPendingIfNeeded`
      );
      const enqueue = async (
        connection: NonNullable<RequestContext['connection']>
      ) => {
        const previous = await this.db.oneOrNull<
          Pick<
            NftLinkEntity,
            | 'media_preview_status'
            | 'media_preview_source_hash'
            | 'media_preview_error_message'
            | 'media_preview_last_tried_at'
          > & { preview_now: number }
        >(
          `select media_preview_status, media_preview_source_hash,
          media_preview_error_message, media_preview_last_tried_at,
          ${PREVIEW_DB_NOW} as preview_now
         from ${NFT_LINKS_TABLE} where canonical_id = :canonicalId for update`,
          { canonicalId },
          { wrappedConnection: connection }
        );
        if (!previous) return false;
        if (
          isPreviewSizeCooldownActive({
            status: previous.media_preview_status,
            sourceHash: previous.media_preview_source_hash,
            expectedSourceHash: sourceHash,
            message: previous.media_preview_error_message,
            lastTriedAt: previous.media_preview_last_tried_at,
            limitBytes: maxBytes,
            now: Number(previous.preview_now)
          })
        )
          return false;
        const affectedRows = await this.db
          .execute(
            `
            update ${NFT_LINKS_TABLE}
            set
              media_preview_status = :pendingStatus,
              media_preview_kind = :kind,
              media_preview_source_hash = :sourceHash,
              media_preview_error_message = null,
              media_preview_failed_since = null,
              media_preview_locked_since = null,
              media_preview_last_tried_at = null,
              media_preview_last_success_at = case
                when media_preview_source_hash <=> :sourceHash then media_preview_last_success_at
                else null
              end,
              media_preview_card_url = case
                when media_preview_source_hash <=> :sourceHash then media_preview_card_url
                else null
              end,
              media_preview_thumb_url = case
                when media_preview_source_hash <=> :sourceHash then media_preview_thumb_url
                else null
              end,
              media_preview_small_url = case
                when media_preview_source_hash <=> :sourceHash then media_preview_small_url
                else null
              end,
              media_preview_width = case
                when media_preview_source_hash <=> :sourceHash then media_preview_width
                else null
              end,
              media_preview_height = case
                when media_preview_source_hash <=> :sourceHash then media_preview_height
                else null
              end,
              media_preview_mime_type = case
                when media_preview_source_hash <=> :sourceHash then media_preview_mime_type
                else null
              end,
              media_preview_bytes = case
                when media_preview_source_hash <=> :sourceHash then media_preview_bytes
                else null
              end
            where canonical_id = :canonicalId
              and (
                not (media_preview_source_hash <=> :sourceHash)
                or media_preview_status is null
                or media_preview_status in ('FAILED', 'SKIPPED')
              )
          `,
            {
              canonicalId,
              sourceHash,
              kind,
              pendingStatus: 'PENDING'
            },
            { wrappedConnection: connection }
          )
          .then((res) => this.db.getAffectedRows(res));
        return affectedRows > 0;
      };
      return ctx.connection
        ? await enqueue(ctx.connection)
        : await this.db.executeNativeQueriesInTransaction(enqueue);
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->markMediaPreviewPendingIfNeeded`
      );
    }
  }

  public async markMediaPreviewEnqueueFailed(
    canonicalId: string,
    sourceHash: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->markMediaPreviewEnqueueFailed`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `update ${NFT_LINKS_TABLE}
         set media_preview_status = 'FAILED',
             media_preview_error_message = 'Preview enqueue failed',
             media_preview_failed_since = ifnull(media_preview_failed_since, :now)
         where canonical_id = :canonicalId
           and media_preview_source_hash = :sourceHash
           and media_preview_status = 'PENDING'
           and media_preview_locked_since is null`,
        { canonicalId, sourceHash, now: Time.currentMillis() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async markMediaPreviewSkipped(
    {
      canonicalId,
      kind,
      message
    }: {
      canonicalId: string;
      kind: NftLinkMediaPreviewKind;
      message: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->markMediaPreviewSkipped`);
      const now = Time.currentMillis();
      await this.db.execute(
        `
          update ${NFT_LINKS_TABLE}
          set
            media_preview_status = :status,
            media_preview_kind = :kind,
            media_preview_error_message = :message,
            media_preview_failed_since = ifnull(media_preview_failed_since, :now),
            media_preview_locked_since = null,
            media_preview_last_tried_at = :now,
            media_preview_last_success_at = null,
            media_preview_source_hash = null,
            media_preview_card_url = null,
            media_preview_thumb_url = null,
            media_preview_small_url = null,
            media_preview_width = null,
            media_preview_height = null,
            media_preview_mime_type = null,
            media_preview_bytes = null
          where canonical_id = :canonicalId
        `,
        {
          canonicalId,
          kind,
          message,
          now,
          status: 'SKIPPED'
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->markMediaPreviewSkipped`);
    }
  }

  public async lockMediaPreviewForProcessing(
    {
      canonicalId,
      expectedSourceHash,
      lockTTL
    }: {
      canonicalId: string;
      expectedSourceHash?: string | null;
      lockTTL: Time;
    },
    ctx: RequestContext
  ): Promise<(NftLinkEntity & { media_preview_error_message: string }) | null> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->lockMediaPreviewForProcessing`
      );
      return await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
          const entity = await this.db
            .oneOrNull<NftLinkEntity>(
              `
                select * from ${NFT_LINKS_TABLE}
                where canonical_id = :canonicalId
                  and media_preview_status in (:pendingStatus, 'PROCESSING')
                  and (ifnull(media_preview_locked_since, 0) < ${PREVIEW_DB_NOW} - :lockTtlMs
                    or media_preview_locked_since > ${PREVIEW_DB_NOW} + :lockTtlMs)
                  ${expectedSourceHash ? 'and media_preview_source_hash = :expectedSourceHash' : ''}
                for update skip locked
              `,
              {
                canonicalId,
                pendingStatus: 'PENDING',
                lockTtlMs: lockTTL.toMillis(),
                expectedSourceHash: expectedSourceHash ?? null
              },
              { wrappedConnection: connection }
            )
            .then((res) => this.deserializeDullData(res));

          if (!entity) {
            return null;
          }

          const lease = createPreviewLease();
          await this.db.execute(
            `
              update ${NFT_LINKS_TABLE}
              set
                media_preview_status = :processingStatus,
                media_preview_locked_since = ${PREVIEW_DB_NOW},
                media_preview_last_tried_at = ${PREVIEW_DB_NOW},
                media_preview_error_message = :lease
              where canonical_id = :canonicalId
            `,
            {
              canonicalId,
              lease,
              processingStatus: 'PROCESSING'
            },
            { wrappedConnection: connection }
          );

          return {
            ...entity,
            media_preview_status: 'PROCESSING',
            media_preview_error_message: lease
          };
        }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->lockMediaPreviewForProcessing`
      );
    }
  }

  public async updateMediaPreviewWithFailure(
    {
      canonicalId,
      message,
      status,
      fence
    }: {
      canonicalId: string;
      message: string;
      fence: PreviewCompletionFence;
      status?: Extract<NftLinkMediaPreviewStatus, 'FAILED' | 'SKIPPED'>;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateMediaPreviewWithFailure`
      );
      if (!isPreviewLease(fence.lease))
        throw new Error('Invalid NFT preview completion lease');
      const result = await this.db.execute(
        `
          update ${NFT_LINKS_TABLE}
          set
            media_preview_status = :status,
            media_preview_error_message = :message,
            media_preview_locked_since = null,
            media_preview_failed_since = ifnull(media_preview_failed_since, ${PREVIEW_DB_NOW}),
            media_preview_last_tried_at = ${PREVIEW_DB_NOW}
          where canonical_id = :canonicalId
            and media_preview_status = 'PROCESSING'
            and media_preview_source_hash <=> :expectedSourceHash
            and binary media_preview_error_message = binary :lease
        `,
        {
          canonicalId,
          message,
          expectedSourceHash: fence.sourceHash,
          lease: fence.lease,
          status: status ?? 'FAILED'
        },
        { wrappedConnection: ctx.connection }
      );
      return this.db.getAffectedRows(result) > 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateMediaPreviewWithFailure`
      );
    }
  }

  public async updateMediaPreviewWithSuccess(
    {
      canonicalId,
      kind,
      sourceHash,
      cardUrl,
      thumbUrl,
      smallUrl,
      width,
      height,
      mimeType,
      bytes,
      fence
    }: {
      canonicalId: string;
      kind: NftLinkMediaPreviewKind;
      sourceHash: string;
      cardUrl: string;
      thumbUrl: string;
      smallUrl: string;
      width: number | null;
      height: number | null;
      mimeType: string | null;
      bytes: number | null;
      fence: PreviewCompletionFence;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateMediaPreviewWithSuccess`
      );
      if (!isPreviewLease(fence.lease))
        throw new Error('Invalid NFT preview completion lease');
      const result = await this.db.execute(
        `
          update ${NFT_LINKS_TABLE}
          set
            media_preview_status = :status,
            media_preview_kind = :kind,
            media_preview_source_hash = :sourceHash,
            media_preview_card_url = :cardUrl,
            media_preview_thumb_url = :thumbUrl,
            media_preview_small_url = :smallUrl,
            media_preview_width = :width,
            media_preview_height = :height,
            media_preview_mime_type = :mimeType,
            media_preview_bytes = :bytes,
            media_preview_last_success_at = ${PREVIEW_DB_NOW},
            media_preview_last_tried_at = ${PREVIEW_DB_NOW},
            media_preview_failed_since = null,
            media_preview_error_message = null,
            media_preview_locked_since = null
          where canonical_id = :canonicalId
            and media_preview_status = 'PROCESSING'
            and media_preview_source_hash <=> :expectedSourceHash
            and binary media_preview_error_message = binary :lease
        `,
        {
          canonicalId,
          status: 'READY',
          kind,
          sourceHash,
          cardUrl,
          thumbUrl,
          smallUrl,
          width,
          height,
          mimeType,
          bytes,
          expectedSourceHash: fence.sourceHash,
          lease: fence.lease
        },
        { wrappedConnection: ctx.connection }
      );
      return this.db.getAffectedRows(result) > 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateMediaPreviewWithSuccess`
      );
    }
  }
}

export const nftLinksDb = new NftLinksDb(dbSupplier);
