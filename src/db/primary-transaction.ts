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

declare const primaryTransactionBrand: unique symbol;

/** A fresh request scope whose bound primary transaction is still active. */
export interface PrimaryTransactionContext extends RequestContext {
  readonly connection: ConnectionWrapper<unknown>;
  readonly [primaryTransactionBrand]: true;
}

const activeContexts = new WeakSet<object>();
const transactionFailures = new WeakMap<object, { readonly error: unknown }>();
const budgetedContexts = new WeakSet<object>();

export function primaryExecutionBudget(ctx: PrimaryTransactionContext) {
  assertPrimaryTransactionContext(ctx);
  if (!budgetedContexts.has(ctx))
    throw new Error('Primary transaction work requires a SQL execution budget');
  return sqlExecutionBudgetFor(ctx.connection.connection as object);
}

export function assertPrimaryWorkBudget(
  ctx: PrimaryTransactionContext,
  minimumRemainingMillis = 0
): void {
  primaryExecutionBudget(ctx);
  assertSqlWorkBudget(
    ctx.connection.connection as object,
    minimumRemainingMillis
  );
}

/** Keep the first failure even if a caller catches it and returns successfully. */
export function markPrimaryTransactionFailed(
  ctx: RequestContext,
  error: unknown
): void {
  // Error handlers must preserve the original error for invalid/expired contexts.
  if (ctx && activeContexts.has(ctx) && !transactionFailures.has(ctx)) {
    transactionFailures.set(ctx, { error });
  }
}

export function assertPrimaryTransactionContext(
  ctx: RequestContext
): asserts ctx is PrimaryTransactionContext {
  if (!ctx || !activeContexts.has(ctx)) {
    throw new Error('Operations require an active primary transaction');
  }
}

export function primaryQueryOptions(
  ctx: PrimaryTransactionContext,
  statementLimits?: SqlStatementLimits
): DbQueryOptions {
  assertPrimaryTransactionContext(ctx);
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
 * Locking reads remain current reads for publication guards. All
 * queries must use primaryQueryOptions and bypass external result caches.
 */
export async function withPrimaryTransaction<T>(
  db: SqlExecutor,
  executable: (ctx: PrimaryTransactionContext) => Promise<T>,
  ctx: RequestContext = {},
  executionBudget?: SqlExecutionBudget
): Promise<T> {
  if (ctx.connection) {
    throw new Error('Primary transactions cannot nest caller transactions');
  }
  let primary: PrimaryTransactionContext | undefined;
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
        }) as PrimaryTransactionContext;
        activeContexts.add(primary);
        if (executionBudget) {
          budgetedContexts.add(primary);
          primaryExecutionBudget(primary);
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
