import { Logger } from '@/logging';

const RETRY_DELAYS_MS = [250, 750, 2000] as const;
const logger = Logger.get('ETHEREUM_RPC_RETRY');

type ErrorRecord = Record<string, unknown>;

function errorRecord(value: unknown): ErrorRecord | undefined {
  return value !== null && typeof value === 'object'
    ? (value as ErrorRecord)
    : undefined;
}

/** Ethers puts eth_call failures in info.error and other RPC failures in error. */
export function isTransientRpcInternalError(error: unknown): boolean {
  const record = errorRecord(error);
  if (!record) return false;
  // Never reinterpret a decoded contract revert as a transient provider error.
  if (
    record.revert != null ||
    (typeof record.reason === 'string' && record.reason.length > 0) ||
    (typeof record.data === 'string' &&
      record.data !== '' &&
      record.data !== '0x')
  ) {
    return false;
  }

  const info = errorRecord(record.info);
  return [record, errorRecord(record.error), errorRecord(info?.error)].some(
    (candidate) =>
      candidate?.code === -32000 &&
      typeof candidate.message === 'string' &&
      candidate.message.trim().toLowerCase() === 'internal error'
  );
}

/** Opt-in for read operations only; exhausted or unrecognized errors escape intact. */
export async function withTransientRpcRetry<T>(
  read: () => Promise<T>,
  operation: string
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      const result = await read();
      if (retry > 0) {
        logger.info({ event: 'rpc_read_recovered', operation, retries: retry });
      }
      return result;
    } catch (error) {
      const baseDelay = RETRY_DELAYS_MS[retry];
      if (baseDelay === undefined || !isTransientRpcInternalError(error)) {
        throw error;
      }
      const delayMs = Math.round(baseDelay * (1 + Math.random() * 0.2));
      // Do not log error messages, RPC URLs, credentials, or call payloads.
      logger.warn({
        event: 'rpc_read_retry',
        operation,
        retry: retry + 1,
        delay_ms: delayMs
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
