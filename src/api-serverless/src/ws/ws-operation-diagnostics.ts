import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';

export type WsDiagnosticOperation =
  | 'REGISTER'
  | 'DISCONNECT'
  | 'AUTHENTICATE'
  | 'SYNC_NOTIFICATION_IDENTITIES'
  | 'CLEANUP';
type AcknowledgementOutcome = 'accepted' | 'failed' | 'unavailable';
interface Operation {
  readonly operation_id: string;
  readonly socket_hash: string;
  readonly lambda_request_id: string | null;
  readonly gateway_request_id: string | null;
  operation?: WsDiagnosticOperation;
  acknowledgement: AcknowledgementOutcome | 'not_attempted';
  acknowledgement_type?: string;
}
const storage = new AsyncLocalStorage<Operation>();
const logger = Logger.get('WS_DIAGNOSTICS');

function safeRequestId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_.:=+-]{1,128}$/.test(value) ? value : null;
}

function socketHash(connectionId: string): string {
  return createHash('sha256').update(connectionId).digest('hex');
}

function routeOperation(routeKey: string): WsDiagnosticOperation | undefined {
  if (routeKey === '$connect') return 'REGISTER';
  if (routeKey === '$disconnect') return 'DISCONNECT';
  return undefined;
}

function handlerOutcome(status: number | null): string {
  if (status === null || status >= 500) return 'failed';
  return status >= 400 ? 'rejected' : 'completed';
}

/** Fixed labels and numeric metadata only; logging must not alter socket behavior. */
export function logWebSocketDiagnostic(
  failed: boolean,
  details: Record<string, unknown>
): void {
  try {
    if (failed) logger.warn('[WS_DIAGNOSTIC]', details);
    else logger.info('[WS_DIAGNOSTIC]', details);
  } catch {
    // Preserve the operation's result if the logging transport is unavailable.
  }
}

export function webSocketDiagnosticMetadata(connectionId?: string) {
  const current = storage.getStore();
  const hash =
    connectionId === undefined
      ? current?.socket_hash
      : socketHash(connectionId);
  const matching = current?.socket_hash === hash ? current : undefined;
  return {
    operation_id: matching?.operation_id ?? randomUUID(),
    socket_hash: hash ?? null,
    lambda_request_id: matching?.lambda_request_id ?? null,
    gateway_request_id: matching?.gateway_request_id ?? null,
    request_id: safeRequestId(loggerContext.get()?.requestId)
  };
}

export function setWebSocketDiagnosticOperation(value: unknown): void {
  const current = storage.getStore();
  if (
    current &&
    (value === 'AUTHENTICATE' || value === 'SYNC_NOTIFICATION_IDENTITIES')
  )
    current.operation = value;
}

/** A resolved AppWebSockets.send can hide a transport failure: record at the transport. */
export function recordWebSocketAcknowledgement(
  connectionId: string,
  message: string,
  outcome: AcknowledgementOutcome
): void {
  const current = storage.getStore();
  if (!current) return;
  if (
    current.socket_hash !== socketHash(connectionId) ||
    message.length > 128 * 1024
  )
    return;
  try {
    const frame: unknown = JSON.parse(message);
    const type =
      frame && typeof frame === 'object' && 'type' in frame
        ? frame.type
        : undefined;
    if (
      type === 'AUTHENTICATED' ||
      type === 'AUTHENTICATION_FAILED' ||
      type === 'NOTIFICATION_IDENTITIES_SYNCED'
    ) {
      current.acknowledgement_type = type;
      current.acknowledgement = outcome;
    }
  } catch {
    // Never retain or log frame contents, including malformed frames.
  }
}

export async function withWebSocketOperationDiagnostics<
  T extends { statusCode: number }
>(
  input: {
    routeKey: string;
    connectionId: string;
    lambdaRequestId: string;
    gatewayRequestId?: string;
  },
  action: () => Promise<T>
): Promise<T> {
  const current: Operation = {
    operation_id: randomUUID(),
    socket_hash: socketHash(input.connectionId),
    lambda_request_id: safeRequestId(input.lambdaRequestId),
    gateway_request_id: safeRequestId(input.gatewayRequestId),
    operation: routeOperation(input.routeKey),
    acknowledgement: 'not_attempted'
  };
  return await loggerContext.run({ requestId: input.lambdaRequestId }, () =>
    storage.run(current, async () => {
      const started = performance.now();
      let status: number | null = null;
      try {
        const result = await action();
        status = result.statusCode;
        return result;
      } finally {
        if (current.operation || status === null || status >= 500)
          logWebSocketDiagnostic(
            status === null ||
              status >= 500 ||
              current.acknowledgement === 'failed' ||
              current.acknowledgement === 'unavailable',
            {
              ...webSocketDiagnosticMetadata(input.connectionId),
              event: 'ws_operation',
              operation: current.operation ?? 'OTHER',
              outcome: handlerOutcome(status),
              response_status: status,
              acknowledgement: current.acknowledgement,
              acknowledgement_type: current.acknowledgement_type ?? null,
              total_ms: Math.round(performance.now() - started)
            }
          );
      }
    })
  );
}
