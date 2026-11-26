import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { recoverWithWorkerRedis } from './recovery-redis';
import { recordClientVersionGauge } from '@/ws-client-versions/ws-client-versions';
import { runWaveRelayPublishingBestEffort } from '@/wave-relay-publish/wave-relay-publish';

const logger = Logger.get('WEBSOCKET_DELIVERY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      try {
        await recoverWithWorkerRedis();
      } finally {
        // Per-minute share of connected sockets by frontend build. Best
        // effort: it never fails the recovery run.
        await recordClientVersionGauge();
        // Device-signed drop events to the 6529 relays (off unless
        // FEATURE_WAVES_RELAY_PUBLISH). Best effort, about half a minute.
        await runWaveRelayPublishingBestEffort();
      }
    },
    { logger, entities: [], skipRedis: true }
  );
});
