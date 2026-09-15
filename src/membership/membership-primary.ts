import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import type { RequestContext } from '@/request.context';
import type { ConnectionWrapper, SqlExecutor } from '@/sql-executor';

declare const membershipPrimaryBrand: unique symbol;

/** A fresh request scope whose bound primary transaction is still active. */
export interface MembershipPrimaryContext extends RequestContext {
  readonly connection: ConnectionWrapper<unknown>;
  readonly [membershipPrimaryBrand]: true;
}

const activeContexts = new WeakSet<object>();
const transactionFailures = new WeakMap<object, { readonly error: unknown }>();

/** Keep the first failure even if a caller catches it and returns successfully. */
export function markMembershipTransactionFailed(
  ctx: RequestContext,
  error: unknown
): void {
  // Error handlers must preserve the original error for invalid/expired contexts.
  if (ctx && activeContexts.has(ctx) && !transactionFailures.has(ctx)) {
    transactionFailures.set(ctx, { error });
  }
}

export function assertMembershipPrimaryContext(
  ctx: RequestContext
): asserts ctx is MembershipPrimaryContext {
  if (!ctx || !activeContexts.has(ctx)) {
    throw new Error(
      'Membership operations require an active primary transaction'
    );
  }
}

export function membershipQueryOptions(
  ctx: MembershipPrimaryContext
): DbQueryOptions {
  assertMembershipPrimaryContext(ctx);
  return { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE };
}

/**
 * Own a short primary transaction; the first consistent read fixes its snapshot.
 * Locking reads remain current reads for publication guards. All membership
 * queries must use membershipQueryOptions and bypass external result caches.
 */
export async function withMembershipPrimaryTransaction<T>(
  db: SqlExecutor,
  executable: (ctx: MembershipPrimaryContext) => Promise<T>,
  ctx: RequestContext = {}
): Promise<T> {
  if (ctx.connection) {
    throw new Error(
      'Membership primary transactions cannot nest caller transactions'
    );
  }
  return db.executeNativeQueriesInTransaction(
    async (connection) => {
      const primary = Object.freeze({
        moderationRequestId: ctx.moderationRequestId,
        moderationPermitGeneration: ctx.moderationPermitGeneration,
        timer: ctx.timer,
        authenticationContext: ctx.authenticationContext,
        connection: Object.freeze({ connection: connection.connection }),
        requestScope: { promisesByKey: new Map<string, Promise<unknown>>() }
      }) as MembershipPrimaryContext;
      activeContexts.add(primary);
      try {
        const result = await executable(primary);
        const failure = transactionFailures.get(primary);
        if (failure) {
          throw failure.error;
        }
        return result;
      } finally {
        // Revoke before the adapter commits, rolls back, or releases the connection.
        activeContexts.delete(primary);
        transactionFailures.delete(primary);
      }
    },
    { isolationLevel: 'REPEATABLE READ' }
  );
}
