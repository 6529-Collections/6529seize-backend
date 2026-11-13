import { WsConnectionPurpose } from '@/entities/IWSConnection';

/**
 * Socket churn split by what a socket is for. `app` is a socket without a
 * declared purpose (the drop/wave socket); `typing` declared `purpose=typing`.
 * No identity ids: only the purpose and whether the socket is authenticated.
 */
export type WsSocketPurposeLabel = 'app' | 'typing';

export function socketPurposeLabel(
  purpose: WsConnectionPurpose | null | undefined
): WsSocketPurposeLabel {
  return purpose === WsConnectionPurpose.TYPING ? 'typing' : 'app';
}

function environment(): 'staging' | 'prod' | 'unknown' {
  if ((process.env.SENTRY_ENVIRONMENT ?? '').includes('staging'))
    return 'staging';
  return process.env.AWS_REGION === 'us-east-1' ? 'prod' : 'unknown';
}

/**
 * One EMF record in `6529/WebSocketConnections` per registration or
 * deregistration. `LifetimeMs` (from the gateway's `connectedAt`) is emitted
 * per disconnect, so CloudWatch percentiles give the lifetime distribution.
 */
export function recordSocketLifecycle({
  event,
  purpose,
  authenticated,
  lifetimeMs
}: {
  readonly event: 'Registered' | 'Deregistered';
  readonly purpose: WsSocketPurposeLabel;
  readonly authenticated: boolean;
  readonly lifetimeMs?: number | null;
}): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const lifetime =
    typeof lifetimeMs === 'number' && Number.isFinite(lifetimeMs)
      ? Math.max(0, Math.round(lifetimeMs))
      : null;
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/WebSocketConnections',
              Dimensions: [['Environment', 'Purpose', 'Authenticated']],
              Metrics: [
                { Name: event, Unit: 'Count' },
                ...(lifetime === null
                  ? []
                  : [{ Name: 'LifetimeMs', Unit: 'Milliseconds' }])
              ]
            }
          ]
        },
        Environment: environment(),
        Purpose: purpose,
        Authenticated: authenticated ? 'true' : 'false',
        [event]: 1,
        ...(lifetime === null ? {} : { LifetimeMs: lifetime })
      })}\n`
    );
  } catch {
    /* Telemetry must not affect connection handling. */
  }
}
