import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { DbQueryOptions } from '@/db-query.options';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';

/** Migration-only failure context. Never attach SQL text, parameters or rows to
 * the error: bulk statements may contain private source values. Inherited
 * oneOrNull/bulkUpsert helpers call this.execute, retaining this interception. */
export class MigrationCopySqlExecutor extends SqlExecutor {
  private statementNumber = 0;

  constructor(private readonly delegate: SqlExecutor) {
    super();
  }

  public async execute<T = unknown>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const statementNumber = ++this.statementNumber;
    try {
      return await this.delegate.execute<T>(sql, params, options);
    } catch (error) {
      // The loop's QueryRunner wraps the physical timeout. The transaction
      // budget still rejects with the original driver error, so annotate that
      // same object rather than the SQL-bearing TypeORM wrapper. Propagating it
      // also preserves the typed diagnostic contract for direct query callers.
      const budgetError =
        error instanceof QueryFailedError ? error.driverError : error;
      if (!(budgetError instanceof SqlExecutionBudgetExceededError))
        throw error;
      if (Object.isExtensible(budgetError)) {
        Object.assign(budgetError, {
          migrationStatementNumber: statementNumber,
          migrationStatementFingerprint: createHash('sha256')
            .update(sql)
            .digest('hex')
        });
      }
      throw budgetError;
    }
  }

  public executeNativeQueriesInTransaction<T>(
    action: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.delegate.executeNativeQueriesInTransaction(action, options);
  }
}
