import { ConnectionWrapper } from './sql-executor';
import type { SqlBudgetQueryOptions } from '@/db/sql-execution-budget';

export enum DbPoolName {
  READ = 'READ',
  WRITE = 'WRITE'
}

export interface DbQueryOptions extends SqlBudgetQueryOptions {
  forcePool?: DbPoolName;
  wrappedConnection?: ConnectionWrapper<any>;
}
