import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import type { RequestContext } from '@/request.context';
import type {
  ConnectionWrapper,
  SqlExecutor,
  SqlExecutionBudget,
  SqlStatementLimits
} from '@/sql-executor';
import {
  assertSqlWorkBudget,
  sqlExecutionBudgetFor,
  sqlExecutionBudgetTokenFor
} from '@/db/sql-execution-budget';

declare const membershipPrimaryBrand: unique symbol;

/** A fresh request scope whose bound primary transaction is still active. */
export interface MembershipPrimaryContext extends RequestContext {
  readonly connection: ConnectionWrapper<unknown>;
  readonly [membershipPrimaryBrand]: true;
}

const activeContexts = new WeakSet<object>();
const transactionFailures = new WeakMap<object, { readonly error: unknown }>();
const budgetedContexts = new WeakSet<object>();

export function membershipExecutionBudget(ctx: MembershipPrimaryContext) {
  assertMembershipPrimaryContext(ctx);
  if (!budgetedContexts.has(ctx))
    throw new Error('Membership work requires a SQL execution budget');
  return sqlExecutionBudgetFor(ctx.connection.connection as object);
}

export function assertMembershipWorkBudget(
  ctx: MembershipPrimaryContext,
  minimumRemainingMillis = 0
): void {
  membershipExecutionBudget(ctx);
  assertSqlWorkBudget(
    ctx.connection.connection as object,
    minimumRemainingMillis
  );
}

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
  ctx: MembershipPrimaryContext,
  statementLimits?: SqlStatementLimits
): DbQueryOptions {
  assertMembershipPrimaryContext(ctx);
  if (budgetedContexts.has(ctx)) {
    return {
      wrappedConnection: ctx.connection,
      forcePool: DbPoolName.WRITE,
      executionBudgetToken: sqlExecutionBudgetTokenFor(
        ctx.connection.connection as object
      ),
      statementLimits
    };
  }
  if (statementLimits)
    throw new Error('Statement limits require a SQL execution budget');
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
  ctx: RequestContext = {},
  executionBudget?: SqlExecutionBudget
): Promise<T> {
  if (ctx.connection) {
    throw new Error(
      'Membership primary transactions cannot nest caller transactions'
    );
  }
  let primary: MembershipPrimaryContext | undefined;
  const revoke = () => {
    if (primary) {
      activeContexts.delete(primary);
      transactionFailures.delete(primary);
      budgetedContexts.delete(primary);
    }
  };
  try {
    return await db.executeNativeQueriesInTransaction(
      async (connection) => {
        primary = Object.freeze({
          moderationRequestId: ctx.moderationRequestId,
          moderationPermitGeneration: ctx.moderationPermitGeneration,
          timer: ctx.timer,
          authenticationContext: ctx.authenticationContext,
          connection: Object.freeze({ connection: connection.connection }),
          requestScope: { promisesByKey: new Map<string, Promise<unknown>>() }
        }) as MembershipPrimaryContext;
        activeContexts.add(primary);
        if (executionBudget) {
          budgetedContexts.add(primary);
          membershipExecutionBudget(primary);
        }
        try {
          const result = await executable(primary);
          const failure = transactionFailures.get(primary);
          if (failure) {
            throw failure.error;
          }
          return result;
        } finally {
          // Revoke before the adapter commits, rolls back, or releases the connection.
          revoke();
        }
      },
      {
        isolationLevel: 'REPEATABLE READ',
        ...(executionBudget ? { executionBudget } : {})
      }
    );
  } finally {
    // The adapter can abort while the user callback remains pending forever.
    revoke();
  }
}

/**
 * Bind membership source writes to an existing caller-owned WRITE transaction.
 * The caller owns commit/rollback and must not catch the error returned here.
 * This adapter cannot turn a replica or an already committed connection into a
 * primary transaction. Use it only from the transaction owner's callback.
 */
export async function withMembershipPrimaryMutationContext<T>(
  connection: ConnectionWrapper<unknown>,
  executable: (ctx: MembershipPrimaryContext) => Promise<T>,
  ctx: RequestContext = {}
): Promise<T> {
  if (!connection?.connection || ctx.connection) {
    throw new Error(
      'Membership mutation requires a caller-owned WRITE transaction'
    );
  }
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
    if (failure) throw failure.error;
    return result;
  } finally {
    activeContexts.delete(primary);
    transactionFailures.delete(primary);
  }
}
