import { isError } from 'ethers';

const DIAGNOSTIC_CODES = [
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  'CALL_EXCEPTION',
  'BAD_DATA',
  'UNSUPPORTED_OPERATION'
] as const;

/** Emit only known constants, never provider-controlled messages or URLs. */
export function getNextgenRpcErrorCode(error: unknown): string {
  return (
    DIAGNOSTIC_CODES.find((code) => isError(error, code)) ?? 'UNKNOWN_ERROR'
  );
}
