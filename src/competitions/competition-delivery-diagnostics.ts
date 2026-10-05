const DELIVERY_ERROR_CODES = new Set([
  'PUSH_QUEUE_PARTIAL_FAILURE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'TimeoutError',
  'NetworkingError',
  'ThrottlingException',
  'ServiceUnavailable',
  'AccessDeniedException',
  'CredentialsProviderError'
]);

/** Provider messages, stacks and arbitrary codes can contain request payloads. */
export function competitionDeliveryErrorCode(error: unknown): string {
  try {
    if (error === null || typeof error !== 'object') return 'UNKNOWN';
    const candidate = error as { code?: unknown; name?: unknown };
    for (const code of [candidate.code, candidate.name]) {
      if (typeof code === 'string' && DELIVERY_ERROR_CODES.has(code))
        return code;
    }
  } catch {
    // Treat even unreadable provider exceptions as opaque.
  }
  return 'UNKNOWN';
}
