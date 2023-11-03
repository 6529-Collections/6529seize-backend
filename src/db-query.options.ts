export enum DbPoolName {
  READ = 'READ',
  WRITE = 'WRITE'
}

export interface DbQueryOptions {
  forcePool?: DbPoolName;
}
