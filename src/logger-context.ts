import { AsyncLocalStorage } from 'node:async_hooks';

export interface LoggerContextValue {
  requestId?: string;
  jwtSub?: string;
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
