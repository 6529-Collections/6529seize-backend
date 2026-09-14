import { WsMessageType } from './ws-message';

const outboundTypes = new Set<string>([
  WsMessageType.DROP_UPDATE,
  WsMessageType.DROP_UPDATE_REF,
  WsMessageType.DROP_DELETE,
  WsMessageType.DROP_RATING_UPDATE,
  WsMessageType.DROP_REACTION_UPDATE,
  WsMessageType.USER_IS_TYPING,
  WsMessageType.AUTHENTICATED,
  WsMessageType.AUTHENTICATION_FAILED,
  WsMessageType.NOTIFICATION_IDENTITIES_SYNCED,
  WsMessageType.IDENTITY_NOTIFICATIONS_CHANGED,
  WsMessageType.DM_UNREAD_STATE_CHANGED,
  WsMessageType.MEDIA_LINK_UPDATED,
  WsMessageType.ATTACHMENT_STATUS_UPDATE
]);

type ErrorCategory =
  | 'THROTTLED'
  | 'FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_REQUEST'
  | 'SERVICE_ERROR'
  | 'TRANSPORT_ERROR'
  | 'OTHER';

const categories = new Map<string, ErrorCategory>([
  ['LimitExceededException', 'THROTTLED'],
  ['ThrottlingException', 'THROTTLED'],
  ['ForbiddenException', 'FORBIDDEN'],
  ['PayloadTooLargeException', 'PAYLOAD_TOO_LARGE'],
  ['BadRequestException', 'INVALID_REQUEST'],
  ['TimeoutError', 'TRANSPORT_ERROR'],
  ['RequestTimeout', 'TRANSPORT_ERROR'],
  ['RequestTimeoutException', 'TRANSPORT_ERROR']
]);
const transportCodes = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN'
]);
// Diagnostic parsing never needs to exceed the API Gateway message ceiling.
const MAX_INSPECTED_FRAME_CHARACTERS = 128 * 1024;

function readProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function integer(value: unknown, minimum: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : null;
}

function frameType(message: unknown): string {
  if (
    typeof message !== 'string' ||
    message.length > MAX_INSPECTED_FRAME_CHARACTERS
  )
    return 'OTHER';
  try {
    const value = readProperty(JSON.parse(message), 'type');
    return typeof value === 'string' && outboundTypes.has(value)
      ? value
      : 'OTHER';
  } catch {
    return 'OTHER';
  }
}

function errorCategory(
  name: unknown,
  code: unknown,
  status: number | null
): ErrorCategory {
  if (status === 429) return 'THROTTLED';
  if (typeof name === 'string' && categories.has(name))
    return categories.get(name)!;
  if (status === 403) return 'FORBIDDEN';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status !== null && status >= 500) return 'SERVICE_ERROR';
  if (typeof code === 'string' && transportCodes.has(code))
    return 'TRANSPORT_ERROR';
  return 'OTHER';
}

/** Inspect only fixed labels and numeric SDK metadata; never retain the frame or exception. */
export function describeWebSocketSendFailure(message: unknown, error: unknown) {
  const name = readProperty(error, 'name');
  const metadata = readProperty(error, '$metadata');
  const rawStatus = integer(readProperty(metadata, 'httpStatusCode'), 100);
  const status = rawStatus !== null && rawStatus <= 599 ? rawStatus : null;
  const errorMessage = readProperty(error, 'message');
  const unavailable =
    name === 'GoneException' ||
    status === 410 ||
    (name === 'BadRequestException' &&
      typeof errorMessage === 'string' &&
      errorMessage.includes('Invalid connectionId'));

  return {
    unavailable,
    diagnostic: {
      code: 'WS_OUTBOUND_SEND_FAILED' as const,
      frame_type: frameType(message),
      error_category: errorCategory(name, readProperty(error, 'code'), status),
      http_status: status,
      sdk_attempts: integer(readProperty(metadata, 'attempts'), 1),
      sdk_retry_delay_ms: integer(readProperty(metadata, 'totalRetryDelay'), 0)
    }
  };
}
