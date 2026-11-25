import {
  isTransactionConfirmation,
  isTransactionConfirmationText
} from '@/arweave/transaction-status';
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

function validateTransactionStatus(
  response: ResponseWithData<unknown>,
  responseType: RequestInitWithAxios['responseType']
): void {
  if (response.status === 202) return;
  const data = validationData(response.data, responseType);
  const confirmed =
    responseType === 'text' || responseType === 'arraybuffer'
      ? typeof data === 'string' && isTransactionConfirmationText(data)
      : isTransactionConfirmation(data);
  if (response.status !== 200 || !confirmed)
    throw new Error('Invalid Arweave transaction status');
}

function validationData(
  data: unknown,
  responseType: RequestInitWithAxios['responseType']
): unknown {
  return responseType === 'arraybuffer' && data instanceof ArrayBuffer
    ? new TextDecoder().decode(data)
    : data;
}

function validateApiData(
  path: string,
  response: ResponseWithData<unknown>,
  responseType: RequestInitWithAxios['responseType']
): void {
  const data = validationData(response.data, responseType);
  if (/^tx\/[\w-]+\/status$/.test(path))
    validateTransactionStatus(response, responseType);
  if (
    path === 'tx_anchor' &&
    (typeof data !== 'string' || !/^[\w-]{43,64}$/.test(data))
  )
    throw new Error('Invalid Arweave API response');
  if (/^(price\/|wallet\/.*\/balance)/.test(path)) {
    if (
      (typeof data !== 'string' && typeof data !== 'number') ||
      !/^\d+$/.test(String(data))
    )
      throw new Error('Invalid Arweave API response');
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
    const endpoint = path.startsWith('/') ? path.slice(1) : path;
    try {
      return await recoverArweave(
        ARWEAVE_WRITE_GATEWAYS.map((host) => `https://${host}`),
        async (origin, signal) => {
          const index = ARWEAVE_WRITE_GATEWAYS.findIndex(
            (host) => origin === `https://${host}`
          );
          const response = await endpoints[index].request<T>(endpoint, {
            ...init,
            headers: new Headers(init.headers),
            redirect: 'error',
            signal
          });
          if (!response.ok && response.status !== 202)
            throw new ArweaveApiResponseError(response);
          validateApiData(endpoint, response, init.responseType);
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
            ) && options.shouldRetry?.(error) !== false
        }
      );
    } catch (error) {
      // Status queries deliberately expose a final absence only after trying every node.
      if (
        error instanceof ArweaveApiResponseError &&
        error.response.status === 404 &&
        /^tx\/[\w-]+\/status$/.test(endpoint)
      ) {
        return error.response as ResponseWithData<T>;
      }
      throw error;
    }
  };
  return client;
}
