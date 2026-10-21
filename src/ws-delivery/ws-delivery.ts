import { randomInt, randomUUID } from 'node:crypto';
import { Logger } from '@/logging';
import { describeWebSocketSendFailure } from '@/api/ws/ws-send-diagnostics';
import {
  connectionHash,
  DeliveryClaim,
  WebSocketDeliveryStore,
  webSocketDeliveryStore
} from './ws-delivery-store';
import { shouldReconnectListener } from './ws-delivery-policy';

export type WebSocketDeliveryResult =
  | { status: 'sent' }
  | { status: 'resync_pending' }
  | { status: 'gone' }
  | { status: 'failed' };

interface DeliveryInput {
  connectionId: string;
  message: string;
  send: () => Promise<unknown>;
  close?: () => Promise<void>;
  recovery?: boolean;
  signal?: AbortSignal;
}

const logger = Logger.get('WEBSOCKET_DELIVERY');
let lastStoreFailureAt = 0;

function controlAcknowledgement(message: string): boolean {
  if (message.length > 2048) return false;
  const type = describeWebSocketSendFailure(message, undefined).diagnostic
    .frame_type;
  return (
    type === 'AUTHENTICATED' ||
    type === 'AUTHENTICATION_FAILED' ||
    type === 'NOTIFICATION_IDENTITIES_SYNCED'
  );
}

function reportStoreFailure(): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  metric('RecoveryUnavailable');
  const now = Date.now();
  if (now - lastStoreFailureAt < 60_000) return;
  lastStoreFailureAt = now;
  try {
    logger.warn({
      event: 'WS_RECOVERY_STORE_UNAVAILABLE',
      recovery: 'unknown'
    });
  } catch {
    /* Reporting must not delete a live connection. */
  }
}

type DeliveryMetric =
  | 'Sent'
  | 'Gone'
  | 'Throttled'
  | 'Deferred'
  | 'Failed'
  | 'Reconnected'
  | 'RecoveryUnavailable'
  | 'Cancelled';

function metric(outcome: DeliveryMetric, sdkAttempts = 0): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const environment = (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
  // Fixed, low-cardinality dimensions. Never make a connection a metric dimension.
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/WebSocketDelivery',
              Dimensions: [['Environment']],
              Metrics: [
                { Name: outcome, Unit: 'Count' },
                { Name: 'Attempted', Unit: 'Count' },
                { Name: 'SdkAttempts', Unit: 'Count' },
                { Name: 'SdkRetries', Unit: 'Count' }
              ]
            }
          ]
        },
        Environment: environment,
        [outcome]: 1,
        Attempted: [
          'Sent',
          'Gone',
          'Throttled',
          'Failed',
          'Cancelled'
        ].includes(outcome)
          ? 1
          : 0,
        SdkAttempts: sdkAttempts,
        SdkRetries: Math.max(0, sdkAttempts - 1)
      })}\n`
    );
  } catch {
    /* Telemetry must not alter delivery. */
  }
}

function completedSdkAttempts(response: unknown): number {
  try {
    if (!response || typeof response !== 'object') return 0;
    const metadata = Reflect.get(response, '$metadata');
    if (!metadata || typeof metadata !== 'object') return 0;
    const attempts = Reflect.get(metadata, 'attempts');
    return typeof attempts === 'number' &&
      Number.isSafeInteger(attempts) &&
      attempts > 0 &&
      attempts <= 1000
      ? attempts
      : 0;
  } catch {
    return 0;
  }
}

export class WebSocketDelivery {
  constructor(
    private readonly store: Pick<
      WebSocketDeliveryStore,
      'claim' | 'finish' | 'snapshot' | 'forget' | 'enableReconnect'
    > = webSocketDeliveryStore
  ) {}

  /** Older bundles suppress normal-close reconnects; opt in only at connection creation. */
  async enableReconnect(connectionId: string): Promise<void> {
    try {
      await this.store.enableReconnect(connectionId);
    } catch {
      reportStoreFailure();
    }
  }

  async deliver(input: DeliveryInput): Promise<WebSocketDeliveryResult> {
    const token = randomUUID();
    const claim = await this.claim(input, token);
    if (claim && !claim.acquired) {
      metric('Deferred');
      return { status: 'resync_pending' };
    }
    if (await this.reconnectBlockedListener(input, token, claim))
      return { status: 'gone' };
    try {
      const response = await input.send();
      await this.finish(input, token, claim, 'sent');
      metric('Sent', completedSdkAttempts(response));
      return { status: 'sent' };
    } catch (error) {
      if (input.signal?.aborted) {
        await this.finish(input, token, claim, 'failed');
        metric('Cancelled');
        return { status: 'failed' };
      }
      return this.handleFailure(input, token, claim, error);
    }
  }

  private async reconnectBlockedListener(
    input: DeliveryInput,
    token: string,
    claim: DeliveryClaim | null
  ): Promise<boolean> {
    if (!input.recovery || !claim?.canReconnect || !input.close) return false;
    const snapshot = await this.store
      .snapshot(Date.now(), input.connectionId)
      .catch(() => null);
    if (
      !snapshot ||
      !shouldReconnectListener(
        snapshot,
        claim.failures,
        claim.firstFailureAt,
        Date.now()
      )
    )
      return false;
    // Do not delete a subscription until AWS confirms transport closure.
    try {
      await input.close();
      await this.finish(input, token, claim, 'gone');
      metric('Reconnected');
      return true;
    } catch {
      try {
        logger.warn({
          event: 'WS_LISTENER_CLOSE_FAILED',
          connection_hash: connectionHash(input.connectionId)
        });
      } catch {
        /* Reporting must not alter the transport outcome. */
      }
      return false;
    }
  }

  private async claim(
    input: DeliveryInput,
    token: string
  ): Promise<DeliveryClaim | null> {
    try {
      return await this.store.claim(
        input.connectionId,
        token,
        input.recovery ?? false,
        Date.now(),
        controlAcknowledgement(input.message)
      );
    } catch {
      // The transport can still deliver during a Redis outage. The worker and
      // EMF counters retain independent operational signals for lost recovery.
      reportStoreFailure();
      return null;
    }
  }

  private async finish(
    input: DeliveryInput,
    token: string,
    claim: DeliveryClaim | null,
    outcome: 'sent' | 'throttled' | 'gone' | 'failed'
  ): Promise<boolean | null> {
    if (!claim) return null;
    try {
      return await this.store.finish({
        connectionId: input.connectionId,
        token,
        outcome,
        recovery: input.recovery ?? false,
        revision: claim.revision,
        now: Date.now(),
        jitter: randomInt(1_000_000) / 1_000_000,
        coalesce: !controlAcknowledgement(input.message)
      });
    } catch {
      reportStoreFailure();
      return null;
    }
  }

  private async handleFailure(
    input: DeliveryInput,
    token: string,
    claim: DeliveryClaim | null,
    error: unknown
  ): Promise<WebSocketDeliveryResult> {
    const failure = describeWebSocketSendFailure(input.message, error);
    if (failure.unavailable) {
      await this.finish(input, token, claim, 'gone');
      metric('Gone', failure.diagnostic.sdk_attempts ?? 0);
      return { status: 'gone' };
    }
    if (failure.diagnostic.error_category === 'THROTTLED') {
      return this.throttled(input, token, claim, failure.diagnostic);
    }
    await this.finish(input, token, claim, 'failed');
    metric('Failed', failure.diagnostic.sdk_attempts ?? 0);
    try {
      logger.error({
        ...failure.diagnostic,
        connection_hash: connectionHash(input.connectionId)
      });
    } catch {
      /* Reporting must not turn a provider failure into connection deletion. */
    }
    return { status: 'failed' };
  }

  private async throttled(
    input: DeliveryInput,
    token: string,
    claim: DeliveryClaim | null,
    diagnostic: ReturnType<typeof describeWebSocketSendFailure>['diagnostic']
  ): Promise<WebSocketDeliveryResult> {
    const control = controlAcknowledgement(input.message);
    const firstFailure = await this.finish(input, token, claim, 'throttled');
    metric('Throttled', diagnostic.sdk_attempts ?? 0);
    if (firstFailure) {
      try {
        logger.warn({
          ...diagnostic,
          connection_hash: connectionHash(input.connectionId),
          recovery: control
            ? 'control_acknowledgement_failed'
            : 'resync_pending'
        });
      } catch {
        /* Delivery remains best effort if logging fails. */
      }
    }
    if (control) {
      if (claim?.canReconnect && (await this.closeUnacknowledgedControl(input)))
        return { status: 'gone' };
      return { status: 'failed' };
    }
    return { status: firstFailure === null ? 'failed' : 'resync_pending' };
  }

  private async closeUnacknowledgedControl(
    input: DeliveryInput
  ): Promise<boolean> {
    if (!input.close) return false;
    // Control acknowledgements cannot be replaced by cache refreshes.
    try {
      await input.close();
    } catch {
      return false;
    }
    await this.store.forget(input.connectionId).catch(reportStoreFailure);
    return true;
  }
}

export const webSocketDelivery = new WebSocketDelivery();
