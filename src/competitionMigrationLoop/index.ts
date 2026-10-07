import type { Context } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { CompetitionMigrationService } from '@/competitions/competition-migration.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import {
  assertMigrationLambdaEnvironment,
  assertMigrationLambdaOperator,
  parseMigrationLambdaInput,
  type MigrationLambdaInput
} from './migration-input';
import { executeMigrationLambdaInput } from './migration-runner';

const logger = Logger.get('COMPETITION_MIGRATION_LOOP');

export async function queueMigrationContinuation(
  input: MigrationLambdaInput,
  functionArn: string,
  region: string
): Promise<void> {
  const client = new LambdaClient({
    region,
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000,
      socketTimeout: 10000
    })
  });
  try {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: functionArn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(input))
      })
    );
    if (response.StatusCode !== 202)
      throw new Error(
        'Migration continuation was not accepted; invoke again to resume'
      );
  } finally {
    client.destroy();
  }
}

export function createMigrationHandler(configuration: {
  readonly environment: string | undefined;
  readonly region: string | undefined;
  readonly operators: string | undefined;
}) {
  // Pin cold-start configuration across warm invocations. Loading the regional
  // secret mutates process.env, but cannot redirect subsequent invocations.
  const deployment = Object.freeze({ ...configuration });
  return async (event: unknown, context: Context): Promise<unknown> => {
    const input = parseMigrationLambdaInput(event);
    assertMigrationLambdaEnvironment(
      input,
      deployment.environment,
      deployment.region
    );
    return doInDbContext(
      async () => {
        assertMigrationLambdaOperator(
          input,
          deployment.operators ?? process.env.COMPETITION_MIGRATION_OPERATORS
        );
        logger.info('migration_invocation', {
          action: input.action,
          environment: input.environment,
          waveId: input.wave_id,
          operator: input.operator,
          live: input.live,
          runId: input.continuation?.run_id,
          requestId: context.awsRequestId
        });
        const result = await executeMigrationLambdaInput(
          input,
          new CompetitionMigrationService(
            undefined,
            undefined,
            undefined,
            input.environment
          ),
          {
            now: Date.now,
            remainingTime: () => context.getRemainingTimeInMillis(),
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            progress: (message) => logger.info(message),
            continueMigration: (next) =>
              queueMigrationContinuation(
                next,
                context.invokedFunctionArn,
                deployment.region!
              )
          }
        );
        logger.info('migration_invocation_finished', {
          action: input.action,
          waveId: input.wave_id,
          requestId: context.awsRequestId
        });
        return result;
      },
      { logger, syncEntities: false, skipRedis: true }
    );
  };
}

export const handleMigration = createMigrationHandler({
  environment: process.env.MIGRATION_DEPLOYED_ENVIRONMENT,
  region: process.env.AWS_REGION,
  operators: process.env.COMPETITION_MIGRATION_OPERATORS
});
export const handler = sentryContext.wrapLambdaHandler(handleMigration);
