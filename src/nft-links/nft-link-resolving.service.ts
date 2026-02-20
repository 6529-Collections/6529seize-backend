import {
  nftLinkResolver,
  NftLinkResolver
} from '@/nft-links/nft-link-resolver';
import { nftLinksDb, NftLinksDb } from '@/nft-links/nft-links.db';
import { Logger } from '@/logging';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { validateLinkUrl } from '@/nft-links/nft-link-resolver.validator';
import { CanonicalLink } from '@/nft-links/types';
import { Time } from '@/time';
import { env } from '@/env';
import { RequestContext } from '@/request.context';
import { sqs, SQS } from '@/sqs';
import { NftLinkEntity } from '@/entities/INftLink';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { mapNftLinkEntityToApiLink } from '@/nft-links/nft-link-api.mapper';

export class NftLinkResolvingService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly nftLinkResolver: NftLinkResolver,
    private readonly nftLinksDb: NftLinksDb,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly sqs: SQS
  ) {}

  public async getLinkData(
    url: string,
    ctx: RequestContext
  ): Promise<ApiNftLinkData | null> {
    const canonical = validateLinkUrl(url);
    const canonicalId = canonical.canonicalId;
    const cachedData = await this.nftLinksDb.findByCanonicalId(
      canonicalId,
      ctx
    );
    let reasonForCacheRefresh;
    if (cachedData) {
      reasonForCacheRefresh = Time.millis(cachedData.last_tried_to_update)
        .plus(this.getUpdateMinInterval())
        .isInPast();
    } else {
      const identifiers = canonical.identifiers as any;
      await this.nftLinksDb.insertPendingOrDoNothing(
        {
          platform: canonical.platform,
          canonical_id: canonical.canonicalId,
          contract: identifiers.contract ?? null,
          chain: identifiers.chain ?? null,
          token: identifiers.tokenId ?? null,
          custom_id:
            identifiers.instanceSlug ??
            identifiers.instanceId ??
            identifiers.appId ??
            null
        },
        ctx
      );
      reasonForCacheRefresh = true;
    }
    if (reasonForCacheRefresh) {
      const queueUrl = env.getStringOrNull(`NFT_LINK_REFRESH_SQS_QUEUE`);
      if (queueUrl) {
        if (!cachedData) {
          await giveReadReplicaTimeToCatchUp();
        }
        await this.sqs.send({
          message: { rawUrl: canonical.originalUrl },
          queue: queueUrl
        });
      } else {
        await this.attemptResolve(canonical.originalUrl, ctx);
      }
    }
    const entity = await this.nftLinksDb.findByCanonicalId(canonicalId, ctx);
    if (entity) {
      return this.entityToApiLink(entity);
    }
    return null;
  }

  public async ensureTrackingForUrls(urls: string[], ctx: RequestContext) {
    await this.trackUrls(urls, ctx, false);
  }

  public async refreshStaleTrackingForUrls(
    urls: string[],
    ctx: RequestContext
  ) {
    await this.trackUrls(urls, ctx, true);
  }

  public async attemptResolve(url: string, ctx: RequestContext) {
    const lockTTL = Time.millis(
      env.getIntOrNull('NFT_LINK_RESOLVER_LOCK_TTL') ??
        Time.minutes(2).toMillis()
    );
    const updateMinInterval = this.getUpdateMinInterval();

    this.logger.info(`Attempting to resolve ${url}`);
    let canonicalLink: CanonicalLink;
    try {
      canonicalLink = validateLinkUrl(url);
    } catch (e) {
      this.logger.error(
        `${url} didn't pass first level validation and should have never reached here`
      );
      return;
    }
    const entity = await this.nftLinksDb.lockForProcessing(
      { canonicalId: canonicalLink.canonicalId, lockTTL, updateMinInterval },
      ctx
    );
    if (!entity) {
      this.logger.info(`Didn't find ready to process entity for url ${url}`);
      return;
    }
    const MAX_ATTEMPTS = 5;
    const waitBetweenTries = Time.seconds(10);
    let didPersistSuccess = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const card = await this.nftLinkResolver.resolve(url, ctx);
        await this.nftLinksDb.updateWithSuccess(card, ctx);
        didPersistSuccess = true;
        this.logger.info(`Data for ${url} updated`);
        break;
      } catch (e: any) {
        if (attempt === MAX_ATTEMPTS) {
          await this.nftLinksDb.updateWithFailure(
            {
              canonicalId: canonicalLink.canonicalId,
              message: e?.message ?? JSON.stringify(e)
            },
            ctx
          );
          this.logger.error(
            `Attempt #${attempt} of ${MAX_ATTEMPTS}. Failed to update url ${url}`,
            e
          );
        } else {
          this.logger.error(
            `Attempt #${attempt} of ${MAX_ATTEMPTS}. Failed to update url ${url}. Will try again after ${waitBetweenTries}`,
            e
          );
          await waitBetweenTries.sleep();
        }
      }
    }

    if (!didPersistSuccess) {
      return;
    }

    // Notification is best-effort and should not affect persisted resolution.
    try {
      const dataAfterUpdate = await this.nftLinksDb.findByCanonicalId(
        canonicalLink.canonicalId,
        ctx
      );
      if (dataAfterUpdate) {
        await giveReadReplicaTimeToCatchUp();
        await this.wsListenersNotifier.notifyAboutNftLinkUpdate(
          this.entityToApiLink(dataAfterUpdate),
          ctx
        );
      }
    } catch (notifyErr) {
      this.logger.error(`Failed to send WS notification for ${url}`, notifyErr);
    }
  }
  private getUpdateMinInterval() {
    return Time.millis(
      env.getIntOrNull('NFT_LINK_RESOLVER_MIN_UPDATE_INTERVAL') ??
        Time.minutes(2).toMillis()
    );
  }

  private async trackUrls(
    urls: string[],
    ctx: RequestContext,
    refreshIfStale: boolean
  ) {
    const uniqueCanonicals = urls.reduce((acc, url) => {
      try {
        const canonical = validateLinkUrl(url);
        if (!acc.has(canonical.canonicalId)) {
          acc.set(canonical.canonicalId, canonical);
        }
      } catch (e) {
        // Best effort by design. Invalid or unsupported URLs are skipped.
      }
      return acc;
    }, new Map<string, CanonicalLink>());
    if (!uniqueCanonicals.size) {
      return;
    }

    const existingLinks = await this.nftLinksDb.findByCanonicalIds(
      Array.from(uniqueCanonicals.keys()),
      ctx
    );
    const existingByCanonicalId = new Map(
      existingLinks.map((it) => [it.canonical_id, it] as const)
    );

    const queueTargets: string[] = [];
    const missingCanonicals: CanonicalLink[] = [];
    for (const canonical of Array.from(uniqueCanonicals.values())) {
      const existing = existingByCanonicalId.get(canonical.canonicalId);
      if (!existing) {
        missingCanonicals.push(canonical);
        queueTargets.push(canonical.originalUrl);
        continue;
      }
      if (
        refreshIfStale &&
        Time.millis(existing.last_tried_to_update)
          .plus(this.getUpdateMinInterval())
          .isInPast()
      ) {
        queueTargets.push(canonical.originalUrl);
      }
    }
    if (missingCanonicals.length) {
      await Promise.all(
        missingCanonicals.map((canonical) => {
          const identifiers = canonical.identifiers as any;
          return this.nftLinksDb.insertPendingOrDoNothing(
            {
              platform: canonical.platform,
              canonical_id: canonical.canonicalId,
              contract: identifiers.contract ?? null,
              chain: identifiers.chain ?? null,
              token: identifiers.tokenId ?? null,
              custom_id:
                identifiers.instanceSlug ??
                identifiers.instanceId ??
                identifiers.appId ??
                null
            },
            ctx
          );
        })
      );
    }

    if (!queueTargets.length) {
      return;
    }
    const queueUrl = env.getStringOrNull(`NFT_LINK_REFRESH_SQS_QUEUE`);
    if (queueUrl) {
      await Promise.all(
        queueTargets.map((rawUrl) =>
          this.sqs.send({
            message: { rawUrl },
            queue: queueUrl
          })
        )
      );
      return;
    }
    await Promise.all(
      queueTargets.map((rawUrl) => this.attemptResolve(rawUrl, ctx))
    );
  }

  private entityToApiLink(entity: NftLinkEntity): ApiNftLinkData {
    return mapNftLinkEntityToApiLink(entity);
  }
}

export const nftLinkResolvingService = new NftLinkResolvingService(
  nftLinkResolver,
  nftLinksDb,
  wsListenersNotifier,
  sqs
);
