import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { DbQueryOptions } from '@/db-query.options';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { RequestContext } from '@/request.context';
import { SqlExecutor } from '@/sql-executor';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { ArtworkDocumentationDb } from './artwork-documentation.db';

/** Keep every eligibility read on the documentation primary/transaction. */
class DocumentationGroupReadExecutor extends SqlExecutor {
  constructor(
    private readonly documentationDb: ArtworkDocumentationDb,
    private readonly ctx: RequestContext
  ) {
    super();
  }
  execute<T>(
    sql: string,
    params: Record<string, unknown> = {},
    options?: DbQueryOptions
  ): Promise<T[]> {
    if (!/^\s*(?:select|with)\b/i.test(sql))
      throw new Error('GROUP_EVALUATION_READ_ONLY');
    return this.documentationDb.query<T>(sql, params, {
      ...this.ctx,
      connection: options?.wrappedConnection ?? this.ctx.connection
    });
  }
  async executeNativeQueriesInTransaction<T>(): Promise<T> {
    throw new Error('GROUP_EVALUATION_READ_ONLY');
  }
}

export function documentationViewerGroups(
  db: ArtworkDocumentationDb,
  ctx: RequestContext
) {
  const executor = new DocumentationGroupReadExecutor(db, ctx);
  return new UserGroupsService(
    new UserGroupsDb(() => executor),
    abusivenessCheckService,
    metricsRecorder
  );
}
