import { WsMessageType } from './ws-message';

export function redactWebSocketMessageForLog(message: unknown): unknown {
  if (Array.isArray(message)) {
    return message.map(redactWebSocketMessageForLog);
  }

  if (typeof message !== 'object' || !message) {
    return message;
  }

  const record = message as Record<string, unknown>;
  if (
    record.type === WsMessageType.AUTHENTICATE ||
    record.type === WsMessageType.SYNC_NOTIFICATION_IDENTITIES
  ) {
    return { type: record.type };
  }

  return {
    ...record,
    ...('access_token' in record ? { access_token: '[REDACTED]' } : {}),
    ...('token' in record ? { token: '[REDACTED]' } : {})
  };
}
