import { ConnectionWrapper } from './sql-executor';

export enum DbPoolName {
  READ = 'READ',
  WRITE = 'WRITE'
}

export interface DbQueryOptions {
  forcePool?: DbPoolName;
  wrappedConnection?: ConnectionWrapper<any>;
}
