import { WsMessageType } from './ws-message';

export function redactWebSocketMessageForLog(message: unknown): unknown {
  if (typeof message !== 'object' || !message || Array.isArray(message)) {
    return message;
  }

  const record = message as Record<string, unknown>;
  if (record.type === WsMessageType.AUTHENTICATE) {
    return { type: record.type };
  }

  return {
    ...record,
    ...('access_token' in record ? { access_token: '[REDACTED]' } : {}),
    ...('token' in record ? { token: '[REDACTED]' } : {})
  };
}
