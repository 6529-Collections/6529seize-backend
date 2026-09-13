const ERROR_CODES = new Set([
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_TABLE',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'PROTOCOL_CONNECTION_LOST'
]);

/** Only fixed diagnostic labels survive; never copy messages, SQL or IDs. */
export function typingFailureDetails(error: unknown) {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  let errorType = 'Unknown';
  if (error instanceof TypeError) {
    errorType = 'TypeError';
  } else if (error instanceof Error) {
    errorType = 'Error';
  }
  return {
    error_type: errorType,
    error_code:
      typeof code === 'string' && ERROR_CODES.has(code) ? code : 'OTHER'
  };
}
