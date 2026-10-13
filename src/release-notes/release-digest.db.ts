import {
  RELEASE_DIGEST_ENTRIES_TABLE,
  RELEASE_DIGESTS_TABLE
} from '@/constants';
import {
  ReleaseDigestEntity,
  ReleaseDigestEntryEntity,
  ReleaseDigestStatus
} from '@/entities/IReleaseDigest';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';

export interface ReleaseDigestContributor {
  readonly github_login: string;
  readonly handle: string | null;
  readonly profile_id: string | null;
}

export interface NewReleaseDigestEntry {
  readonly id: string;
  readonly repository: string;
  readonly pull_request_number: number;
  readonly pull_request_title: string;
  readonly pull_request_url: string;
  readonly pull_request_body: string | null;
  readonly summary: string;
  readonly contributors: readonly ReleaseDigestContributor[];
  readonly services: readonly string[];
  readonly publication_id: string;
  readonly deployed_at: number;
}

export interface ClaimReleaseDigestInput {
  readonly digestId: string;
  readonly digestKey: string;
  readonly cutoff: number;
  readonly limit: number;
  readonly now: number;
}

export const RELEASE_DIGEST_PENDING_RETRY_LIMIT = 5;

function queryOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

export class ReleaseDigestDb extends LazyDbAccessCompatibleService {
  public constructor(sqlExecutorSupplier: () => SqlExecutor = dbSupplier) {
    super(sqlExecutorSupplier);
  }

  /**
   * Records production pull requests for the daily digest. Regenerated
   * per-deploy notes refresh their text but never release an entry that a
   * digest already claimed.
   */
  public async recordEntries(
    entries: readonly NewReleaseDigestEntry[],
    ctx: RequestContext
  ): Promise<void> {
    if (!entries.length) {
      return;
    }
    const timerName = `${this.constructor.name}->recordEntries`;
    ctx.timer?.start(timerName);
    try {
      const now = Date.now();
      for (const entry of entries) {
        await this.db.execute(
          `insert into ${RELEASE_DIGEST_ENTRIES_TABLE} (
             id, repository, pull_request_number, pull_request_title,
             pull_request_url, pull_request_body, summary,
             contributors, services, publication_id,
             deployed_at, digest_id, created_at, updated_at
           ) values (
             :id, :repository, :pullRequestNumber, :pullRequestTitle,
             :pullRequestUrl, :pullRequestBody, :summary,
             :contributors, :services, :publicationId,
             :deployedAt, null, :now, :now
           )
           on duplicate key update
             pull_request_title = values(pull_request_title),
             pull_request_body = values(pull_request_body),
             summary = values(summary),
             contributors = values(contributors),
             services = values(services),
             updated_at = values(updated_at)`,
          {
            id: entry.id,
            repository: entry.repository,
            pullRequestNumber: entry.pull_request_number,
            pullRequestTitle: entry.pull_request_title,
            pullRequestUrl: entry.pull_request_url,
            pullRequestBody: entry.pull_request_body,
            summary: entry.summary,
            contributors: JSON.stringify(entry.contributors),
            services: JSON.stringify(entry.services),
            publicationId: entry.publication_id,
            deployedAt: entry.deployed_at,
            now
          },
          queryOptions(ctx)
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findDigestByKey(
    digestKey: string,
    ctx: RequestContext
  ): Promise<ReleaseDigestEntity | null> {
    return this.db.oneOrNull<ReleaseDigestEntity>(
      `select * from ${RELEASE_DIGESTS_TABLE} where digest_key = :digestKey`,
      { digestKey },
      queryOptions(ctx)
    );
  }

  public async findPendingDigests(
    excludeDigestKey: string,
    ctx: RequestContext
  ): Promise<ReleaseDigestEntity[]> {
    return this.db.execute<ReleaseDigestEntity>(
      `select * from ${RELEASE_DIGESTS_TABLE}
       where status = :status and digest_key <> :excludeDigestKey
       order by created_at asc
       limit ${RELEASE_DIGEST_PENDING_RETRY_LIMIT}`,
      { status: ReleaseDigestStatus.Pending, excludeDigestKey },
      queryOptions(ctx)
    );
  }

  public async findUnclaimedEntries(
    cutoff: number,
    limit: number,
    ctx: RequestContext
  ): Promise<ReleaseDigestEntryEntity[]> {
    return this.db.execute<ReleaseDigestEntryEntity>(
      `select * from ${RELEASE_DIGEST_ENTRIES_TABLE}
       where digest_id is null and deployed_at <= :cutoff
       order by deployed_at asc, id asc
       limit :limit`,
      { cutoff, limit },
      queryOptions(ctx)
    );
  }

  /**
   * Returns the digest for this key, creating it and claiming every
   * unclaimed entry deployed up to the cutoff when it does not exist yet.
   * Returns null when there is nothing to publish.
   */
  public async claimDigest(
    input: ClaimReleaseDigestInput,
    ctx: RequestContext
  ): Promise<ReleaseDigestEntity | null> {
    const timerName = `${this.constructor.name}->claimDigest`;
    ctx.timer?.start(timerName);
    try {
      return await this.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          const existing = await this.db.oneOrNull<ReleaseDigestEntity>(
            `select * from ${RELEASE_DIGESTS_TABLE}
             where digest_key = :digestKey
             for update`,
            { digestKey: input.digestKey },
            queryOptions(txCtx)
          );
          if (existing) {
            return existing;
          }
          const claimable = await this.db.execute<{ id: string }>(
            `select id from ${RELEASE_DIGEST_ENTRIES_TABLE}
             where digest_id is null and deployed_at <= :cutoff
             order by deployed_at asc, id asc
             limit :limit
             for update`,
            { cutoff: input.cutoff, limit: input.limit },
            queryOptions(txCtx)
          );
          if (!claimable.length) {
            return null;
          }
          await this.db.execute(
            `insert into ${RELEASE_DIGESTS_TABLE} (
               id, digest_key, status, entry_count, drop_id,
               created_at, published_at
             ) values (
               :id, :digestKey, :status, :entryCount, null, :now, null
             )`,
            {
              id: input.digestId,
              digestKey: input.digestKey,
              status: ReleaseDigestStatus.Pending,
              entryCount: claimable.length,
              now: input.now
            },
            queryOptions(txCtx)
          );
          await this.db.execute(
            `update ${RELEASE_DIGEST_ENTRIES_TABLE}
             set digest_id = :digestId, updated_at = :now
             where id in (:ids) and digest_id is null`,
            {
              digestId: input.digestId,
              ids: claimable.map((row) => row.id),
              now: input.now
            },
            queryOptions(txCtx)
          );
          return this.db.oneOrNull<ReleaseDigestEntity>(
            `select * from ${RELEASE_DIGESTS_TABLE} where id = :id`,
            { id: input.digestId },
            queryOptions(txCtx)
          );
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findEntriesForDigest(
    digestId: string,
    ctx: RequestContext
  ): Promise<ReleaseDigestEntryEntity[]> {
    return this.db.execute<ReleaseDigestEntryEntity>(
      `select * from ${RELEASE_DIGEST_ENTRIES_TABLE}
       where digest_id = :digestId
       order by deployed_at asc, id asc`,
      { digestId },
      queryOptions(ctx)
    );
  }

  public async markPublished(
    digestId: string,
    dropId: string,
    publishedAt: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `update ${RELEASE_DIGESTS_TABLE}
       set status = :status, drop_id = :dropId, published_at = :publishedAt
       where id = :digestId`,
      {
        status: ReleaseDigestStatus.Published,
        dropId,
        publishedAt,
        digestId
      },
      queryOptions(ctx)
    );
  }
}

export const releaseDigestDb = new ReleaseDigestDb();
