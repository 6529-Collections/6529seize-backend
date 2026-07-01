import { ConnectionWrapper } from './sql-executor';
import { Timer } from './time';
import { AuthenticationContext } from './auth-context';

export interface RequestScope {
  readonly promisesByKey: Map<string, Promise<unknown>>;
}

export interface RequestContext {
  readonly connection?: ConnectionWrapper<any>;
  readonly timer?: Timer;
  readonly authenticationContext?: AuthenticationContext;
  /**
   * Best-effort memoization for async work performed with the same ctx object.
   * It is attached non-enumerably, so spreading ctx intentionally starts a new
   * scope. Cache keys must include every input that changes the returned value.
   */
  readonly requestScope?: RequestScope;
}

type MutableRequestContext = Omit<RequestContext, 'requestScope'> & {
  requestScope?: RequestScope;
};

function getOrCreateRequestScope(ctx: RequestContext): RequestScope {
  const mutableCtx = ctx as MutableRequestContext;
  if (!mutableCtx.requestScope) {
    Object.defineProperty(mutableCtx, 'requestScope', {
      value: { promisesByKey: new Map() },
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
  return mutableCtx.requestScope as RequestScope;
}

export function getRequestScopedPromise<T>(
  ctx: RequestContext,
  key: string,
  getValue: () => Promise<T>
): Promise<T> {
  const requestScope = getOrCreateRequestScope(ctx);
  const existingPromise = requestScope.promisesByKey.get(key);
  if (existingPromise) {
    return existingPromise as Promise<T>;
  }

  const promise = getValue();
  requestScope.promisesByKey.set(key, promise);
  void promise.catch(() => {
    if (requestScope.promisesByKey.get(key) === promise) {
      requestScope.promisesByKey.delete(key);
    }
  });
  return promise;
}
