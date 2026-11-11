import { DbPoolName } from '@/db-query.options';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  ARTWORK_ASSET_QUOTAS_TABLE,
  ARTWORK_ASSETS_TABLE,
  ARTWORK_ASSET_LIST_COLUMNS,
  ArtworkAssetListRow,
  AssetConnection,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';
import {
  ARTWORK_UPLOAD_POLICY,
  assetError,
  publicationAssetAccess,
  requirePublicationAsset,
  validateStartUpload
} from '@/artwork-documentation/assets/artwork-assets.policy';
import { AD_CONTEXTS } from '@/artwork-documentation/artwork-documentation.tables';
import { parseJson } from '@/artwork-documentation/artwork-documentation.db';
import type {
  DocumentationProfile,
  Modules
} from '@/artwork-documentation/artwork-documentation.types';

/** Processing claims allowed per asset before it is marked failed. */
export const MAX_ASSET_PROCESSING_ATTEMPTS = 360;
export const ASSET_SCAN_TIMEOUT_MS = 6 * 60 * 60_000;

/** True once an asset has used its attempts or outlived its scan window. */
export function isAssetProcessingExhausted(
  asset: Pick<StoredAsset, 'attempts' | 'created_at'>,
  now: number
): boolean {
  return (
    Number(asset.attempts) >= MAX_ASSET_PROCESSING_ATTEMPTS ||
    now - Number(asset.created_at) >
      ASSET_SCAN_TIMEOUT_MS + ARTWORK_UPLOAD_POLICY.upload_lifetime_ms
  );
}
const PROCESSING_LEASE_MS = 15 * 60_000;
const MAX_CLAIM_RETRY_DELAY_MS = 60 * 60_000;
// Exhausted assets marked failed while looking for one to process.
const MAX_EXHAUSTED_ASSETS_PER_CLAIM = 10;

/**
 * Extra delay after the lease before a claimed asset is offered again if
 * its worker never finishes it: one minute per attempt, at most an hour.
 * A finished attempt sets its own next_attempt_at.
 */
export function processingClaimRetryDelayMs(attempts: number): number {
  return Math.min(Math.max(attempts, 1) * 60_000, MAX_CLAIM_RETRY_DELAY_MS);
}

export class ArtworkAssetsDb extends LazyDbAccessCompatibleService {
  async find(
    id: string,
    contextId?: string,
    connection?: AssetConnection,
    lock = false
  ): Promise<StoredAsset | null> {
    return this.db.oneOrNull<StoredAsset>(
      `select * from ${ARTWORK_ASSETS_TABLE} where id = :id ${contextId ? 'and context_id = :contextId' : ''} ${lock ? 'for update' : ''}`,
      { id, contextId },
      { wrappedConnection: connection, forcePool: DbPoolName.WRITE }
    );
  }
  async list(contextId: string): Promise<StoredAsset[]> {
    return this.db.execute<StoredAsset>(
      `select * from ${ARTWORK_ASSETS_TABLE} where context_id = :contextId and reserved_bytes > 0 order by created_at asc`,
      { contextId },
      { forcePool: DbPoolName.WRITE }
    );
  }
  async listSummaries(contextId: string): Promise<ArtworkAssetListRow[]> {
    return this.db.execute<ArtworkAssetListRow>(
      `select ${ARTWORK_ASSET_LIST_COLUMNS.join(',')} from ${ARTWORK_ASSETS_TABLE} where context_id = :contextId and reserved_bytes > 0 order by created_at asc`,
      { contextId },
      { forcePool: DbPoolName.WRITE }
    );
  }
  async reserve(asset: StoredAsset): Promise<StoredAsset> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      // Share the context-first lock order with profile upgrades. Authorization
      // loaded before this transaction cannot authorize an obsolete intake mode.
      const context = await this.db.oneOrNull<{
        lifecycle: string;
        profile_json: string;
        modules_json: string;
      }>(
        `select lifecycle, profile_json, modules_json from ${AD_CONTEXTS} where id = :contextId for update`,
        { contextId: asset.context_id },
        options
      );
      if (!context) assetError(404, 'ASSET_CONTEXT_NOT_FOUND');
      if (context.lifecycle !== 'active')
        assetError(403, 'ASSET_EDIT_FORBIDDEN');
      const access = publicationAssetAccess({
        profile: parseJson<DocumentationProfile>(context.profile_json),
        modules: parseJson<Modules>(context.modules_json)
      });
      requirePublicationAsset(access, asset);
      validateStartUpload(
        { ...asset, size_bytes: Number(asset.size_bytes) },
        access
      );
      await this.db.execute(
        // ON DUPLICATE KEY UPDATE takes an exclusive lock immediately; INSERT
        // IGNORE's shared duplicate lock can deadlock when concurrent writers
        // subsequently upgrade it with SELECT FOR UPDATE.
        `insert into ${ARTWORK_ASSET_QUOTAS_TABLE} (context_id) values (:contextId) on duplicate key update context_id = :contextId`,
        { contextId: asset.context_id },
        options
      );
      await this.db.execute(
        `select context_id from ${ARTWORK_ASSET_QUOTAS_TABLE} where context_id = :contextId for update`,
        { contextId: asset.context_id },
        options
      );
      const prior = await this.db.oneOrNull<StoredAsset>(
        `select * from ${ARTWORK_ASSETS_TABLE} where context_id = :contextId and uploader_profile_id = :actor and request_key = :key`,
        {
          contextId: asset.context_id,
          actor: asset.uploader_profile_id,
          key: asset.request_key
        },
        options
      );
      if (prior) {
        if (prior.request_hash !== asset.request_hash)
          assetError(409, 'IDEMPOTENCY_MISMATCH');
        return prior;
      }
      const usage = await this.db.oneOrNull<{
        bytes: number;
        count: number;
        active: number;
      }>(
        `select coalesce(sum(reserved_bytes), 0) as bytes, coalesce(sum(reserved_bytes > 0), 0) as count, coalesce(sum(state in ('created','uploading','processing')), 0) as active from ${ARTWORK_ASSETS_TABLE} where context_id = :contextId`,
        { contextId: asset.context_id },
        options
      );
      if (
        !usage ||
        Number(usage.bytes) + Number(asset.size_bytes) >
          ARTWORK_UPLOAD_POLICY.context_quota_bytes ||
        Number(usage.count) >= ARTWORK_UPLOAD_POLICY.max_assets
      )
        assetError(413, 'CONTEXT_ASSET_QUOTA');
      if (Number(usage.active) >= ARTWORK_UPLOAD_POLICY.max_concurrent_uploads)
        assetError(429, 'TOO_MANY_ACTIVE_UPLOADS');
      await this.db.bulkInsert(
        ARTWORK_ASSETS_TABLE,
        [asset],
        Object.keys(asset),
        undefined,
        { connection }
      );
      return asset;
    });
  }
  async withLocked<T>(
    id: string,
    contextId: string,
    operation: (asset: StoredAsset, connection: AssetConnection) => Promise<T>
  ): Promise<T> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const asset = await this.find(id, contextId, connection, true);
      if (!asset) assetError(404, 'ASSET_NOT_FOUND');
      return operation(asset, connection);
    });
  }
  async update(
    id: string,
    patch: Partial<StoredAsset>,
    connection?: AssetConnection
  ): Promise<void> {
    // Callers are internal typed services. Never pass request bodies as a patch.
    const entries = Object.entries(patch).filter(
      ([key]) =>
        ![
          'id',
          'context_id',
          'bucket',
          'object_key',
          'uploader_profile_id',
          'request_key',
          'request_hash'
        ].includes(key)
    );
    if (!entries.length) return;
    const assignments = entries
      .map(([key]) => `\`${key}\` = :${key}`)
      .join(', ');
    await this.db.execute(
      `update ${ARTWORK_ASSETS_TABLE} set ${assignments} where id = :id`,
      { id, ...Object.fromEntries(entries) },
      { wrappedConnection: connection }
    );
  }
  async markReferenced(
    contextId: string,
    ids: string[],
    connection: AssetConnection
  ): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(
      `update ${ARTWORK_ASSETS_TABLE} set referenced = 1, expires_at = 0 where context_id = :contextId and id in (:ids) and state = 'ready'`,
      { contextId, ids },
      { wrappedConnection: connection }
    );
  }
  /**
   * Claims the next processing asset. The claim takes a lease, counts the
   * attempt and moves next_attempt_at past the lease with a growing delay,
   * so an asset whose worker dies is not offered first on every tick. An
   * asset that has used all its attempts is marked failed instead.
   */
  async claimProcessing(now: number): Promise<StoredAsset | null> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      for (
        let exhausted = 0;
        exhausted <= MAX_EXHAUSTED_ASSETS_PER_CLAIM;
        exhausted++
      ) {
        // Keep characterization and multipart payloads out of the queue sort.
        const candidate = await this.db.oneOrNull<Pick<StoredAsset, 'id'>>(
          `select id from ${ARTWORK_ASSETS_TABLE} where state = 'processing' and next_attempt_at <= :now and lease_until < :now order by next_attempt_at asc limit 1 for update skip locked`,
          { now },
          { wrappedConnection: connection }
        );
        if (!candidate) return null;
        const asset = await this.find(
          candidate.id,
          undefined,
          connection,
          true
        );
        if (!asset) return null;
        if (isAssetProcessingExhausted(asset, now)) {
          await this.update(
            asset.id,
            {
              state: 'failed',
              failure_code: 'ASSET_PROCESSING_TIMEOUT',
              lease_until: 0,
              next_attempt_at: now,
              updated_at: now
            },
            connection
          );
          continue;
        }
        const lease = now + PROCESSING_LEASE_MS;
        const attempts = Number(asset.attempts) + 1;
        const nextAttemptAt = lease + processingClaimRetryDelayMs(attempts);
        await this.update(
          asset.id,
          { lease_until: lease, attempts, next_attempt_at: nextAttemptAt },
          connection
        );
        return {
          ...asset,
          lease_until: lease,
          attempts,
          next_attempt_at: nextAttemptAt
        };
      }
      return null;
    });
  }
  async finishProcessing(
    asset: StoredAsset,
    patch: Partial<StoredAsset>
  ): Promise<void> {
    await this.withLocked(
      asset.id,
      asset.context_id,
      async (current, connection) => {
        if (
          current.state !== 'processing' ||
          Number(current.lease_until) !== Number(asset.lease_until)
        )
          return;
        const now = Date.now();
        // A finished attempt replaces the claim's crash backoff; retries
        // pass their own next_attempt_at.
        await this.update(
          asset.id,
          { next_attempt_at: now, ...patch, lease_until: 0, updated_at: now },
          connection
        );
      }
    );
  }
  async claimCleanup(now: number): Promise<StoredAsset | null> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      // Hydrate the full row only after its bounded candidate is locked.
      const candidate = await this.db.oneOrNull<Pick<StoredAsset, 'id'>>(
        `select id from ${ARTWORK_ASSETS_TABLE} where referenced = 0 and reserved_bytes > 0 and expires_at > 0 and expires_at < :now and state <> 'processing' and lease_until < :now and next_attempt_at <= :now order by expires_at asc limit 1 for update skip locked`,
        { now },
        { wrappedConnection: connection }
      );
      if (!candidate) return null;
      const asset = await this.find(candidate.id, undefined, connection, true);
      if (!asset) return null;
      const claimed: StoredAsset = {
        ...asset,
        state: 'expired',
        lease_until: now + 15 * 60_000,
        attempts: asset.state === 'expired' ? asset.attempts + 1 : 1,
        updated_at: now
      };
      await this.update(
        asset.id,
        {
          state: claimed.state,
          lease_until: claimed.lease_until,
          attempts: claimed.attempts,
          updated_at: now
        },
        connection
      );
      return claimed;
    });
  }
  async finishCleanup(
    claim: StoredAsset,
    succeeded: boolean,
    now: number
  ): Promise<void> {
    await this.withLocked(
      claim.id,
      claim.context_id,
      async (current, connection) => {
        if (
          current.state !== 'expired' ||
          current.referenced ||
          Number(current.lease_until) !== Number(claim.lease_until)
        )
          return;
        await this.update(
          claim.id,
          {
            reserved_bytes: succeeded ? 0 : current.reserved_bytes,
            lease_until: 0,
            next_attempt_at: succeeded
              ? 0
              : now + Math.min(30, Math.max(1, claim.attempts)) * 60_000,
            failure_code: succeeded ? null : 'ASSET_CLEANUP_RETRY',
            updated_at: now
          },
          connection
        );
      }
    );
  }

  async operationalStats(now: number): Promise<{
    pending: number;
    oldestAgeSeconds: number;
    failuresLastHour: number;
    maxQuotaPercent: number;
  }> {
    const [states, quota] = await Promise.all([
      this.db.oneOrNull<{
        pending: number;
        oldest: number | null;
        failures: number;
      }>(
        `select coalesce(sum(state = 'processing'), 0) pending, min(case when state = 'processing' then expires_at - :orphanLifetime else null end) oldest, coalesce(sum(state in ('failed','quarantined') and updated_at > :recent), 0) failures from ${ARTWORK_ASSETS_TABLE} where state in ('processing','failed','quarantined')`,
        {
          recent: now - 60 * 60_000,
          orphanLifetime: ARTWORK_UPLOAD_POLICY.orphan_lifetime_ms
        },
        { forcePool: DbPoolName.WRITE }
      ),
      this.db.oneOrNull<{ bytes: number }>(
        `select coalesce(max(total), 0) bytes from (select sum(reserved_bytes) total from ${ARTWORK_ASSETS_TABLE} where reserved_bytes > 0 group by context_id) context_usage`,
        {},
        { forcePool: DbPoolName.WRITE }
      )
    ]);
    return {
      pending: Number(states?.pending ?? 0),
      oldestAgeSeconds: states?.oldest
        ? Math.max(0, (now - Number(states.oldest)) / 1000)
        : 0,
      failuresLastHour: Number(states?.failures ?? 0),
      maxQuotaPercent:
        (100 * Number(quota?.bytes ?? 0)) /
        ARTWORK_UPLOAD_POLICY.context_quota_bytes
    };
  }
}
export const artworkAssetsDb = new ArtworkAssetsDb(dbSupplier);
