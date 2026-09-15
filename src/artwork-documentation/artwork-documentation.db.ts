import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { ContextRecord } from './artwork-documentation.types';
import { AD_CONTEXTS, AD_IDEMPOTENCY } from './artwork-documentation.tables';
import { fail } from './artwork-documentation.validation';

export function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

export class ArtworkDocumentationDb extends LazyDbAccessCompatibleService {
  query<T>(
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    // Private records and revocation must never be served from a lagging replica.
    return this.db.execute<T>(sql, params, {
      wrappedConnection: ctx.connection,
      forcePool: DbPoolName.WRITE
    });
  }
  async one<T>(
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T | null> {
    return (await this.query<T>(sql, params, ctx))[0] ?? null;
  }
  async insert(
    table: string,
    values: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<void> {
    const keys = Object.keys(values);
    const columns = keys.map((key) => `\`${key}\``).join(',');
    const parameters = keys.map((key) => `:${key}`).join(',');
    await this.query(
      `INSERT INTO ${table} (${columns}) VALUES (${parameters})`,
      values,
      ctx
    );
  }
  async context(
    id: string,
    ctx: RequestContext,
    lock = false
  ): Promise<ContextRecord | null> {
    const row = await this.one<ContextRecord & Record<string, unknown>>(
      `SELECT * FROM ${AD_CONTEXTS} WHERE id=:id${lock ? ' FOR UPDATE' : ''}`,
      { id },
      ctx
    );
    if (!row) return null;
    return {
      id: row.id,
      work_id: row.work_id,
      owner_profile_id: row.owner_profile_id,
      program_id: row.program_id,
      draft_version: row.draft_version,
      artist_record_revision_id: row.artist_record_revision_id,
      latest_revision_id: row.latest_revision_id,
      lifecycle: row.lifecycle,
      created_at: row.created_at,
      updated_at: row.updated_at,
      profile: parseJson(row.profile_json),
      modules: parseJson(row.modules_json),
      asset_links: parseJson(row.asset_links_json),
      restricted_paths: parseJson(row.restricted_paths_json)
    };
  }
  async saveContext(
    context: ContextRecord,
    ctx: RequestContext
  ): Promise<void> {
    await this.query(
      `UPDATE ${AD_CONTEXTS} SET profile_json=:profile, draft_version=:version, artist_record_revision_id=:artist, latest_revision_id=:revision, lifecycle=:lifecycle, modules_json=:modules, asset_links_json=:assets, restricted_paths_json=:restricted, updated_at=:updated WHERE id=:id`,
      {
        id: context.id,
        profile: JSON.stringify(context.profile),
        version: context.draft_version,
        artist: context.artist_record_revision_id,
        revision: context.latest_revision_id,
        lifecycle: context.lifecycle,
        modules: JSON.stringify(context.modules),
        assets: JSON.stringify(context.asset_links),
        restricted: JSON.stringify(context.restricted_paths),
        updated: context.updated_at
      },
      ctx
    );
  }
  async idempotent<T extends Record<string, unknown>>(
    id: string,
    requestHash: string,
    ctx: RequestContext,
    execute: (transaction: RequestContext) => Promise<T>
  ): Promise<T> {
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const transaction = { ...ctx, connection };
      await this.query(
        `INSERT INTO ${AD_IDEMPOTENCY} (id,request_hash,result_reference_json,expires_at) VALUES (:id,:requestHash,NULL,:expires) ON DUPLICATE KEY UPDATE id=id`,
        { id, requestHash, expires: Date.now() + 7 * 86400000 },
        transaction
      );
      const row = await this.one<{
        request_hash: string;
        result_reference_json: unknown;
      }>(
        `SELECT request_hash,result_reference_json FROM ${AD_IDEMPOTENCY} WHERE id=:id FOR UPDATE`,
        { id },
        transaction
      );
      if (row?.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_MISMATCH');
      if (row.result_reference_json !== null)
        return parseJson<T>(row.result_reference_json);
      const result = await execute(transaction);
      await this.query(
        `UPDATE ${AD_IDEMPOTENCY} SET result_reference_json=:result WHERE id=:id`,
        { id, result: JSON.stringify(result) },
        transaction
      );
      return result;
    });
  }
}
export const artworkDocumentationDb = new ArtworkDocumentationDb(dbSupplier);
