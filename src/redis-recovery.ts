import { FailureCategory } from '@/operational-errors';

export function redisFailureCategory(error: unknown): FailureCategory {
  if (!(error instanceof Error)) return 'UNKNOWN';
  const code = 'code' in error ? error.code : undefined;
  if (
    error.name === 'TimeoutError' ||
    error.constructor.name === 'ConnectionTimeoutError' ||
    code === 'ETIMEDOUT'
  )
    return 'TIMEOUT';
  if (
    (typeof code === 'string' &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EHOSTUNREACH',
        'ENETUNREACH'
      ].includes(code)) ||
    error.constructor.name === 'SocketClosedUnexpectedlyError'
  )
    return 'NETWORK';
  return 'UNKNOWN';
}
