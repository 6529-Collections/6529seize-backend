import { Logger } from '@/logging';
import { helpBotProcessorService } from '@/help-bot/help-bot-processor.service';
import { helpBotDailyActivityCreditQueueService } from '@/help-bot/help-bot-daily-activity-credit-queue.service';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('HELP_BOT_REPLY_LOOP');
const dailyActivityCreditLogger = Logger.get(
  'HELP_BOT_DAILY_ACTIVITY_CREDIT_LOOP'
);
export const DEAD_DAILY_ACTIVITY_CREDIT_REQUEST_LOG_MARKER =
  'HELP_BOT_DAILY_ACTIVITY_CREDIT_REQUEST_DEAD';

function parseRecordBody(body: string): { interaction_id: string } {
  const parsed = JSON.parse(body) as { interaction_id?: unknown };
  const interactionId =
    typeof parsed.interaction_id === 'string'
      ? parsed.interaction_id.trim()
      : '';
  if (!interactionId) {
    throw new Error(`Invalid help bot message payload: ${body}`);
  }
  return { interaction_id: interactionId };
}

export async function processDailyActivityCreditWakeup(): Promise<void> {
  const result =
    await helpBotDailyActivityCreditQueueService.processNextRequest({});

  if (result.dead) {
    dailyActivityCreditLogger.error(
      DEAD_DAILY_ACTIVITY_CREDIT_REQUEST_LOG_MARKER,
      { result }
    );
  }
  await helpBotDailyActivityCreditQueueService.cleanupCompletedRequests({});
  if (result.hasMore) {
    await helpBotDailyActivityCreditQueueService.sendWakeup({});
  }
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        logger.info(
          `Processing help bot interaction ${message.interaction_id}`
        );
        await helpBotProcessorService.processInteraction(
          message.interaction_id,
          {}
        );
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);

const dailyActivityCreditSqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const _record of event.Records) {
        await processDailyActivityCreditWakeup();
      }
    },
    { logger: dailyActivityCreditLogger }
  );
};

export const dailyActivityCreditHandler = sentryContext.wrapLambdaHandler(
  dailyActivityCreditSqsHandler
);
