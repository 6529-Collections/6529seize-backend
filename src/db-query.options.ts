import { ConnectionWrapper } from './sql-executor';
import type { SqlBudgetQueryOptions } from '@/db/sql-execution-budget';

export enum DbPoolName {
  READ = 'READ',
  WRITE = 'WRITE'
}

export interface DbQueryOptions extends SqlBudgetQueryOptions {
  /** Preserve the issuing request across callbacks from a reused MySQL socket. */
  bindInvocationContext?: boolean;
  forcePool?: DbPoolName;
  wrappedConnection?: ConnectionWrapper<any>;
}
