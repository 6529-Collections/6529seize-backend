import { isTransactionConfirmation } from '@/arweave/transaction-status';
import Arweave from 'arweave';
import Api, {
  RequestInitWithAxios,
  ResponseWithData
} from 'arweave/node/lib/api';
import { ARWEAVE_WRITE_GATEWAYS } from '@/arweave/gateways';
import { recoverArweave, ArweaveRecoveryOptions } from '@/arweave/recovery';

class ArweaveApiResponseError extends Error {
  constructor(readonly response: ResponseWithData<unknown>) {
    super(`Arweave API returned HTTP ${response.status}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Every SDK network method shares the same bounded, immutable request replay. */
export function createArweaveClient(
  options: ArweaveRecoveryOptions = {}
): Arweave {
  const client = Arweave.init({
    host: ARWEAVE_WRITE_GATEWAYS[0],
    protocol: 'https',
    port: 443
  });
  const endpoints = ARWEAVE_WRITE_GATEWAYS.map(
    (host) => new Api({ host, protocol: 'https', port: 443 })
  );
  client.api.request = async <T>(
    path: string,
    init: RequestInitWithAxios = {}
  ): Promise<ResponseWithData<T>> => {
    if (init.responseType === 'webstream')
      throw new Error('Arweave recovery requires a buffered response');
    // SDK endpoints are relative paths, never arbitrary caller-controlled origins.
    if (/^[a-z]+:|^\/\//i.test(path))
      throw new Error('Invalid Arweave API path');
    try {
      return await recoverArweave(
        ARWEAVE_WRITE_GATEWAYS.map((host) => `https://${host}`),
        async (origin, signal) => {
          const index = ARWEAVE_WRITE_GATEWAYS.findIndex(
            (host) => origin === `https://${host}`
          );
          const response = await endpoints[index].request<T>(path, {
            ...init,
            headers: new Headers(init.headers),
            redirect: 'error',
            signal
          });
          if (!response.ok && response.status !== 202)
            throw new ArweaveApiResponseError(response);
          if (
            response.status === 200 &&
            /^tx\/[\w-]+\/status$/.test(path) &&
            !isTransactionConfirmation(response.data)
          )
            throw new Error('Invalid Arweave transaction status');
          const text = String(response.data);
          if (
            (path === 'tx_anchor' && !/^[\w-]{43,64}$/.test(text)) ||
            (/^(price\/|wallet\/.*\/balance)/.test(path) && !/^\d+$/.test(text))
          ) {
            throw new Error('Invalid Arweave API response');
          }
          return response;
        },
        {
          signal: init.signal ?? options.signal,
          timeoutMs: options.timeoutMs ?? 30_000,
          attemptTimeoutMs: options.attemptTimeoutMs ?? 10_000,
          shouldRetry: (error) =>
            !(
              error instanceof ArweaveApiResponseError &&
              error.response.status === 400
            )
        }
      );
    } catch (error) {
      // Status queries deliberately expose a final absence only after trying every node.
      if (
        error instanceof ArweaveApiResponseError &&
        error.response.status === 404 &&
        /^tx\/[\w-]+\/status$/.test(path)
      ) {
        return error.response as ResponseWithData<T>;
      }
      throw error;
    }
  };
  return client;
}
