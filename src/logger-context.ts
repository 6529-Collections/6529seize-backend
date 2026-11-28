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
  /**
   * 'mirror' once an identity lookup of this request was answered from the
   * identity mirror's tables because the chain gateway couldn't answer
   * (ChainIdentityReads); the response then says so in a header.
   */
  identitySource?: 'mirror';
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
  },
  setIdentitySource(source: 'mirror') {
    const store = storage.getStore();
    if (store) {
      store.identitySource = source;
    }
  }
};
