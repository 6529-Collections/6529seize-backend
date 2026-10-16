import { appWebSockets } from '@/api/ws/ws';
import { WsMessageType } from '@/api/ws/ws-message';
import { Logger } from '@/logging';
import { webSocketDeliveryStore } from './ws-delivery-store';
import { deliveryHealth } from './ws-delivery-policy';

const logger = Logger.get('WEBSOCKET_RECOVERY');

/** Retry only a content-free refresh marker. Never replay competition effects. */
export async function recoverWebSocketDeliveries(): Promise<void> {
  const startedAt = Date.now();
  let recovered = 0;
  let gone = 0;
  for (let batch = 0; batch < 10 && Date.now() - startedAt < 45_000; batch++) {
    const due = await webSocketDeliveryStore.due(Date.now(), 10);
    if (!due.length) break;
    await Promise.all(
      due.map(async (connectionId) => {
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
      Pending: snapshot.pending
    })}\n`
  );
  logger.info({
    event: 'WS_DELIVERY_HEALTH',
    health,
    ...snapshot,
    recovered,
    gone
  });
}
