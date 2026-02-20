import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { NftLinkEntity } from '@/entities/INftLink';
import { RequestContext } from '@/request.context';
import { NFT_LINKS_TABLE } from '@/constants';
import { Time } from '@/time';
import type { NormalizedNftCard } from '@/nft-links/types';
import { DbPoolName } from '@/db-query.options';

export class NftLinksDb extends LazyDbAccessCompatibleService {
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
      canonicalId,
      lockTTL,
      updateMinInterval
    }: {
      canonicalId: string;
      lockTTL: Time;
      updateMinInterval: Time;
    },
    ctx: RequestContext
  ): Promise<NftLinkEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->lockForProcessing`);
      return await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
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
                lockedSince: Time.now().minus(lockTTL).toMillis(),
                maxLastUpdated: Time.now().minus(updateMinInterval).toMillis()
              },
              { wrappedConnection: connection }
            )
            .then((res) => this.deserializeDullData(res));
          if (entity) {
            await this.db.execute(
              `
            update ${NFT_LINKS_TABLE} 
            set is_locked_since = :now
            where canonical_id = :canonicalId
            `,
              { now: Time.currentMillis(), canonicalId },
              { wrappedConnection: connection }
            );
          }
          return entity;
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
      | 'full_data'
      | 'media_uri'
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
      message
    }: {
      canonicalId: string;
      message: string;
    },
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateWithFailure`);
      await this.db.execute(
        `
            update ${NFT_LINKS_TABLE} 
              set 
                last_tried_to_update = :now,
                last_error_message = :message,
                is_locked_since = null,
                failed_since = ifnull(failed_since, :now)
            where canonical_id = :canonicalId
        `,
        { canonicalId, message, now: Time.currentMillis() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWithFailure`);
    }
  }

  async updateWithSuccess(data: NormalizedNftCard, ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateWithSuccess`);
      const identifiers = data.identifier.identifiers as any;
      await this.db.execute(
        `
            update ${NFT_LINKS_TABLE} 
              set 
                last_tried_to_update = :now,
                last_successfully_updated = :now,
                last_error_message = null,
                is_locked_since = null,
                failed_since = null,
                full_data = :fullData,
                platform = :platform,
                chain = :chain,
                contract = :contract,
                token = :token,
                custom_id = :custom_id,
                media_uri = :media_uri,
                price = :price
            where canonical_id = :canonicalId
        `,
        {
          canonicalId: data.identifier.canonicalId,
          platform: data.identifier.platform,
          chain: identifiers.chain ?? null,
          contract: identifiers.contract ?? null,
          token: identifiers.tokenId ?? null,
          custom_id:
            identifiers.instanceSlug ??
            identifiers.instanceId ??
            identifiers.appId ??
            null,
          media_uri:
            data.asset.media?.imageUrl ??
            data.asset.media?.animationUrl ??
            null,
          fullData: JSON.stringify(data),
          now: Time.currentMillis(),
          price: data.market.price?.amount ?? null
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateWithSuccess`);
    }
  }
}

export const nftLinksDb = new NftLinksDb(dbSupplier);
