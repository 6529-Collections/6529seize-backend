import { Logger } from '@/logging';
import { appWebSockets, SocketNotAvailableException } from '@/api/ws/ws';
import { WsMessageType } from '@/api/ws/ws-message';

export type WebSocketControlOperation =
  | WsMessageType.AUTHENTICATE
  | WsMessageType.SYNC_NOTIFICATION_IDENTITIES;

const logger = Logger.get('WS_CONTROL');

function isUnavailable(error: unknown): boolean {
  try {
    return error instanceof SocketNotAvailableException;
  } catch {
    return false;
  }
}

function reportFailure(
  operation: WebSocketControlOperation,
  stage: 'operation' | 'cleanup'
): void {
  try {
    // The handler's 5xx remains the canonical operational error. This bounded
    // diagnostic adds context without another error event or raw auth/SDK data.
    logger.warn(`[WS_CONTROL_FAILED] [ACTION ${operation}] [STAGE ${stage}]`);
  } catch {
    // Reporting must not replace the original response or prevent cleanup.
  }
}

/** A missing stored connection is lost transport state, not rejected credentials. */
export async function recoverUnavailableWebSocket(
  error: unknown,
  operation: WebSocketControlOperation | undefined,
  connectionId: string
): Promise<boolean> {
  if (operation === undefined) return false;
  if (!isUnavailable(error)) {
    reportFailure(operation, 'operation');
    return false;
  }
  try {
    await appWebSockets.closeUnavailableConnection(connectionId);
    return true;
  } catch {
    reportFailure(operation, 'cleanup');
    return false;
  }
}
