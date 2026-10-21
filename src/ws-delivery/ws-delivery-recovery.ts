import { appWebSockets } from '@/api/ws/ws';
import { WsMessageType } from '@/api/ws/ws-message';
import { webSocketDeliveryStore } from './ws-delivery-store';
import { deliveryHealth } from './ws-delivery-policy';

/** Retry only a content-free refresh marker. Never replay competition effects. */
export async function recoverWebSocketDeliveries(): Promise<void> {
  const startedAt = Date.now();
  let recovered = 0;
  let gone = 0;
  const due = await webSocketDeliveryStore.due(Date.now(), 100);
  // One probe per listener per invocation. Newer coalesced work stays queued
  // for the next run instead of repeatedly probing the same socket in a burst.
  for (
    let offset = 0;
    offset < due.length && Date.now() - startedAt < 45_000;
    offset += 10
  ) {
    await Promise.all(
      due.slice(offset, offset + 10).map(async (connectionId) => {
        const result = await appWebSockets.send({
          connectionId,
          message: JSON.stringify({
            type: WsMessageType.RESYNC_REQUIRED,
            data: {}
          }),
          recovery: true
        });
        if (result.status === 'sent') recovered++;
        if (result.status === 'gone') {
          await webSocketDeliveryStore.forget(connectionId);
          gone++;
        }
      })
    );
  }
  const snapshot = await webSocketDeliveryStore.snapshot(Date.now());
  const health = deliveryHealth(snapshot, Date.now());
  const environment = (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: '6529/WebSocketDelivery',
            Dimensions: [['Environment']],
            Metrics: [
              { Name: 'Degraded', Unit: 'Count' },
              { Name: 'WorkerHealthy', Unit: 'Count' },
              { Name: 'Pending', Unit: 'Count' }
            ]
          }
        ]
      },
      Environment: environment,
      Degraded: health === 'healthy' ? 0 : 1,
      WorkerHealthy: 1,
      Pending: snapshot.pending,
      event: 'WS_DELIVERY_HEALTH',
      health,
      ...snapshot,
      recovered,
      gone
    })}\n`
  );
}
