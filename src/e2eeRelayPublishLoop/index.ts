import {
  defaultE2eeRelayLoopDeps,
  runE2eeRelayPublishLoop
} from '@/e2ee/relay/e2ee-relay-publish-loop';
import {
  E2eeRecordItemEntity,
  E2eeRelayDeletionEntity,
  E2eeRelayOutboxEntity,
  E2eeStreamEntity
} from '@/entities/IE2ee';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('E2EE_RELAY_PUBLISH_LOOP');

/**
 * Every minute while E2EE_RELAY_MODE is on: publishes the relay outbox and
 * DELs, reports the mirror lag (as 6529/E2eeRelay metrics too) and checks
 * each recently moved stream's head on every relay, copying what a relay
 * missed. Does nothing while off.
 * Rollback: E2EE_RELAY_MODE=off.
 */
export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const report = await runE2eeRelayPublishLoop(defaultE2eeRelayLoopDeps());
      logger.info(`[RELAY PUBLISH LOOP] ${JSON.stringify(report)}`);
    },
    {
      logger,
      entities: [
        E2eeStreamEntity,
        E2eeRelayOutboxEntity,
        E2eeRecordItemEntity,
        E2eeRelayDeletionEntity
      ]
    }
  );
});
