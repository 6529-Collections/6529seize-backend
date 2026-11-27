import { chainGatewayConfigFromEnv } from '@/chain-gateway/chain-gateway.client';
import { Logger } from '@/logging';
import {
  buildClaimLogged,
  ChainClaimContext,
  parseChainClaimContext
} from '@/mint-log/mint-claim-build';
import { setMintGateway } from '@/mint-log/mint-gateway';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { chainDecisionResults } from '@/waves-chain-index/waves-chain-index.decision-results';
import type { SQSHandler } from 'aws-lambda';
import type { NativeClaimContext } from '@/competitions/competition-event.repository';

const logger = Logger.get('CLAIMS_BUILDER');
const ALERT_TITLE = 'Claims Builder';

// A chain claim is built only after its result is read from the chain
// through the chain gateway. The gateway client reads CHAIN_GATEWAY_* at its
// first read, inside the handler, after doInDbContext has loaded the lambdas
// secret; binding it here at load reads no setting early.
setMintGateway(chainDecisionResults);

let gatewaySettingsChecked = false;

/**
 * Once per cold start, after the secret has loaded: says so when the chain
 * gateway settings can't be used. It changes nothing else. With no usable
 * CHAIN_GATEWAY_URL the client refuses its first read (not_configured), so
 * every chain claim fails and goes back to the queue; native claims never
 * read the gateway.
 */
function reportGatewaySettingsOnce(): void {
  if (gatewaySettingsChecked) return;
  gatewaySettingsChecked = true;
  try {
    chainGatewayConfigFromEnv();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      `[CHAIN GATEWAY NOT CONFIGURED] ${reason}. Chain claims wait until the gateway settings (CHAIN_GATEWAY_URL, CHAIN_GATEWAY_SERVICE_KEY) are fixed: each one is refused and goes back to the queue. Native claims are built as before.`
    );
  }
}

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
      reportGatewaySettingsOnce();
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
