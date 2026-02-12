import { Logger } from '@/logging';
import { memeClaimsService } from '@/meme-claims/meme-claims.service';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('CLAIMS_BUILDER');
const ALERT_TITLE = 'Claims Builder';

function parseRecordBody(body: string): { drop_id: string } {
  const parsed = JSON.parse(body) as { drop_id?: unknown };
  const dropId =
    typeof parsed.drop_id === 'string' ? parsed.drop_id.trim() : '';
  if (!dropId) {
    throw new Error(`Invalid message payload: ${body}`);
  }
  return { drop_id: dropId };
}

async function processClaimBuild(dropId: string): Promise<void> {
  logger.info(`Processing claim build for drop_id=${dropId}`);
  await memeClaimsService.createClaimForDropIfMissing(dropId);
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        try {
          await processClaimBuild(message.drop_id);
        } catch (error) {
          logger.error(
            `Failed to build claim for drop_id=${message.drop_id}, error=${error}`
          );
          await priorityAlertsContext.sendPriorityAlert(ALERT_TITLE, error);
          throw error;
        }
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
