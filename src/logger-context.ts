import { AsyncLocalStorage } from 'node:async_hooks';

/** SQL time of one API request, summed by `SqlOperationTiming`. */
export interface RequestSqlTotals {
  operations: number;
  /** Summed pool waits; parallel operations overlap, so see the max too. */
  acquisitionMs: number;
  maxAcquisitionMs: number;
  sqlMs: number;
}

export interface LoggerContextValue {
  requestId?: string;
  jwtSub?: string;
  sql?: RequestSqlTotals;
}

const storage = new AsyncLocalStorage<LoggerContextValue>();

export const loggerContext = {
  run<T>(value: LoggerContextValue, callback: () => T): T {
    return storage.run(value, callback);
  },
  get(): LoggerContextValue | undefined {
    return storage.getStore();
  },
  setRequestId(requestId: string | undefined) {
    const store = storage.getStore();
    if (store) {
      store.requestId = requestId;
    }
  },
  setJwtSub(jwtSub: string | undefined) {
    const store = storage.getStore();
    if (store) {
      store.jwtSub = jwtSub;
    }
  }
};
