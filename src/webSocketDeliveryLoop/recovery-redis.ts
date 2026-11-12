import { Logger } from '@/logging';
import { numbers } from '@/numbers';
import { initRedis } from '@/redis';
import { recoverWebSocketDeliveries } from '@/ws-delivery/ws-delivery-recovery';
import {
  createWebSocketDeliveryCluster,
  WebSocketDeliveryStore
} from '@/ws-delivery/ws-delivery-store';

const logger = Logger.get('WS_RECOVERY_REDIS');
let recovery: Promise<() => Promise<void>> | undefined;

export async function connectWebSocketRecoveryRedis() {
  const host = process.env.REDIS_URL;
  const port = numbers.parseIntOrNull(process.env.REDIS_PORT) ?? 6379;
  if (!host || port <= 0 || port > 65535) {
    throw new Error('Invalid WebSocket recovery Redis endpoint');
  }

  const tls = process.env.REDIS_TLS === 'true';
  const cluster = createWebSocketDeliveryCluster({
    rootNodes: [{ socket: { host, port } }],
    defaults: {
      socket: {
        tls,
        connectTimeout: 1_500,
        reconnectStrategy: (retries) => (retries < 2 ? 50 * retries : false)
      },
      password: process.env.REDIS_PASSWORD,
      disableOfflineQueue: true
    },
    // ElastiCache Serverless advertises one virtual primary. Connect before
    // the store starts its command timeout.
    useReplicas: false,
    maxCommandRedirections: 2
  });
  cluster.on('error', (error: Error) => {
    logger.warn(`WebSocket recovery Redis connection error: ${error.message}`);
  });
  await cluster.connect();
  return cluster;
}

async function connectRecovery() {
  const cluster = await connectWebSocketRecoveryRedis();
  const store = new WebSocketDeliveryStore(undefined, () => cluster);
  return async () => {
    try {
      await recoverWebSocketDeliveries(store);
    } catch (error) {
      // Keep fast reconnects within a run. A failed run starts the next
      // invocation with fresh sockets and discovery, without replaying sends.
      recovery = undefined;
      await cluster.disconnect().catch((cause: unknown) => {
        logger.warn(
          `Failed to close WebSocket recovery Redis: ${String(cause)}`
        );
      });
      throw error;
    }
  };
}

export async function recoverWithWorkerRedis(): Promise<void> {
  // Without Redis the worker cannot inspect pending refreshes or report health.
  if (process.env.FORCE_AVOID_REDIS === 'true') {
    throw new Error('WebSocket recovery store unavailable');
  }
  if (process.env.WS_DELIVERY_REDIS_CLUSTER !== 'true') {
    await initRedis();
    await recoverWebSocketDeliveries();
    return;
  }

  recovery ??= connectRecovery().catch((error: unknown) => {
    recovery = undefined;
    throw error;
  });
  await (
    await recovery
  )();
}
