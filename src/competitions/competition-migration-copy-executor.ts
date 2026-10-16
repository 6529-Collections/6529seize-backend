import { createHash } from 'node:crypto';
import { DbQueryOptions } from '@/db-query.options';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';

/** Migration-only failure context. Never attach SQL text, parameters or rows to
 * the error: bulk statements may contain private source values. */
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
      if (error instanceof SqlExecutionBudgetExceededError) {
        Object.assign(error, {
          migrationStatementNumber: statementNumber,
          migrationStatementFingerprint: createHash('sha256')
            .update(sql)
            .digest('hex')
        });
      }
      throw error;
    }
  }

  public executeNativeQueriesInTransaction<T>(
    action: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.delegate.executeNativeQueriesInTransaction(action, options);
  }
}
