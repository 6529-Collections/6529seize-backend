import { Logger } from '@/logging';
import {
  buildClaimLogged,
  ChainClaimContext,
  parseChainClaimContext
} from '@/mint-log/mint-claim-build';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';
import type { NativeClaimContext } from '@/competitions/competition-event.repository';

const logger = Logger.get('CLAIMS_BUILDER');
const ALERT_TITLE = 'Claims Builder';

function parseRecordBody(body: string): {
  drop_id: string;
  competition?: NativeClaimContext;
  chain?: ChainClaimContext;
} {
  const parsed = JSON.parse(body) as {
    drop_id?: unknown;
    competition?: Partial<NativeClaimContext>;
    chain?: unknown;
  };
  const dropId =
    typeof parsed.drop_id === 'string' ? parsed.drop_id.trim() : '';
  if (!dropId) {
    throw new Error('Invalid claim-build message');
  }
  const competition = parsed.competition;
  if (
    competition &&
    [
      competition.competition_id,
      competition.competition_entry_id,
      competition.decision_id
    ].some((id) => typeof id !== 'string' || !id.length)
  ) {
    throw new Error('Invalid native claim context');
  }
  return {
    drop_id: dropId,
    ...(competition ? { competition: competition as NativeClaimContext } : {}),
    ...(parsed.chain === undefined
      ? {}
      : { chain: parseChainClaimContext(parsed.chain) })
  };
}

async function processClaimBuild(
  dropId: string,
  competition?: NativeClaimContext,
  chain?: ChainClaimContext
): Promise<void> {
  logger.info(`Processing claim build for drop_id=${dropId}`);
  await buildClaimLogged({ dropId, competition, chain });
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        try {
          await processClaimBuild(
            message.drop_id,
            message.competition,
            message.chain
          );
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
