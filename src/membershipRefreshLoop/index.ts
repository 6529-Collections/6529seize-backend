import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { wrapLambdaHandler } from '@/sentry.context';
import { sqlExecutor } from '@/sql-executor';
import { PrimaryMembershipProfileEvaluator } from '@/membership/membership-profile-evaluator';
import {
  MembershipRefreshWorker,
  membershipWorkerBudget
} from '@/membership/membership-worker';
import type { MembershipWorkerOptions } from '@/membership/membership-worker.types';
import type { MembershipRefreshScope } from '@/membership/membership-schema.types';
import { withMembershipPrimaryTransaction } from '@/membership/membership-primary';
import { MembershipRuntimeFixtureDb } from '@/membership/membership-runtime-fixture.db';
import {
  MembershipRuntimeTransportDb,
  type MembershipTransportDisposition
} from '@/membership/membership-runtime-transport.db';
import {
  isMembershipRuntimeStatus,
  MEMBERSHIP_FIXTURE_DATABASE,
  parseMembershipWorkerDelivery,
  validateMembershipRuntimeDeployment,
  type MembershipRuntimeEnvironment
} from '@/membership/membership-runtime-policy';

const logger = Logger.get('MEMBERSHIP_REFRESH_LOOP');
const deployment = Object.freeze({
  stage: process.env.MEMBERSHIP_RUNTIME_STAGE,
  region: process.env.AWS_REGION,
  mode: process.env.MEMBERSHIP_RUNTIME_MODE,
  mapping_enabled: process.env.MEMBERSHIP_WORKER_MAPPING_ENABLED,
  queue_arn: process.env.MEMBERSHIP_WORK_QUEUE_ARN,
  queue_url: process.env.MEMBERSHIP_WORK_QUEUE_URL
});

function workerOptions(
  context: Pick<Context, 'getRemainingTimeInMillis'>,
  scope: MembershipRefreshScope
): MembershipWorkerOptions {
  const remaining = context.getRemainingTimeInMillis();
  if (!Number.isFinite(remaining) || remaining < 10_000)
    throw new Error('Insufficient membership invocation budget');
  return {
    deadline_monotonic_millis:
      performance.now() + Math.min(45_000, remaining - 5_000),
    transaction_millis: 15_000,
    max_statement_millis: 1_000,
    finalization_reserve_millis: 2_000,
    checkpoint_reserve_millis: 2_000,
    lock_wait_seconds: 1,
    lease_millis: 90_000,
    // Closed staging acceptance requires independently scheduled continuation.
    max_quanta: 1,
    page_size: scope === 'PROFILE' ? 2 : 1,
    input_limits: {
      max_queries: 300,
      max_input_rows: 100_000,
      max_input_bytes: 8_000_000,
      max_windows: 100,
      raw_window: 128
    },
    retry_millis: 60_000,
    max_attempts: 3
  };
}

function suppressOrFailTransport(
  disposition: MembershipTransportDisposition,
  delivery: ReturnType<typeof parseMembershipWorkerDelivery>,
  requestId: string
): boolean {
  if (disposition.outcome === 'PROCEED') return false;
  logger.info(
    JSON.stringify({
      event: 'membership_fixture_transport',
      request_id: requestId,
      message_id: delivery.message_id,
      receive_count: delivery.receive_count,
      target: delivery.hint.target,
      disposition: disposition.outcome,
      receipt: disposition.receipt
    })
  );
  if (disposition.outcome === 'HELD_MESSAGE')
    throw new Error(
      'Membership fixture holds a committed checkpoint before SQS acknowledgement'
    );
  return true;
}

export async function handleMembershipWorkerInvocation(
  event: unknown,
  context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  environment: MembershipRuntimeEnvironment
) {
  const runtime = validateMembershipRuntimeDeployment(environment);
  if (isMembershipRuntimeStatus(event)) {
    return {
      service: 'membershipRefreshLoop',
      stage: runtime.stage,
      region: runtime.region,
      mode: runtime.mode,
      source_tracking_control: 'per-producer',
      source_readiness: 'unverified',
      materialized_read_control: 'api-separate',
      background_processing_mode: runtime.mode,
      background_processing_code_admission:
        runtime.mode === 'staging-controlled-v1' ? 'controlled' : 'unavailable',
      background_processing_trigger_enabled: runtime.mapping_enabled,
      normal_membership_work:
        runtime.mode === 'staging-controlled-v1' ? 'unverified' : 'unavailable',
      queue_arn: runtime.queue_arn
    };
  }
  const delivery = parseMembershipWorkerDelivery(event, runtime);
  const options = workerOptions(context, delivery.hint.target.scope);
  const result = await doInDbContext(
    async () => {
      const fixtureMode = runtime.mode === 'staging-fixture-v1';
      let inspect:
        | ((
            result: Awaited<
              ReturnType<MembershipRefreshWorker['runTarget']>
            > | null
          ) => Promise<MembershipTransportDisposition>)
        | undefined;
      if (fixtureMode) {
        await withMembershipPrimaryTransaction(
          sqlExecutor,
          (primary) =>
            new MembershipRuntimeFixtureDb(sqlExecutor).assertOwnedDatabase(
              primary
            ),
          {},
          membershipWorkerBudget(options)
        );
        const transport = new MembershipRuntimeTransportDb(sqlExecutor);
        inspect = (result) =>
          withMembershipPrimaryTransaction(
            sqlExecutor,
            (primary) =>
              transport.inspectDelivery(
                delivery.hint.target,
                delivery.message_id,
                result,
                primary
              ),
            {},
            membershipWorkerBudget(options)
          );
        if (
          suppressOrFailTransport(
            await inspect(null),
            delivery,
            context.awsRequestId
          )
        )
          return {
            outcome: 'NO_WORK' as const,
            run_id: null,
            checkpoint_version: null,
            quanta: 0,
            processed_count: '0',
            query_count: 0,
            input_rows: 0
          };
      }
      const result = await new MembershipRefreshWorker(
        sqlExecutor,
        new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
      ).runTarget(delivery.hint.target, options, {}, delivery.hint.delivery);
      if (result.outcome === 'PENDING' && inspect)
        suppressOrFailTransport(
          await inspect(result),
          delivery,
          context.awsRequestId
        );
      return result;
    },
    {
      logger,
      entities: [],
      syncEntities: false,
      skipRedis: true,
      ...(runtime.mode === 'staging-fixture-v1'
        ? {
            databaseSelection: {
              database: MEMBERSHIP_FIXTURE_DATABASE,
              failOnInitializationError: true
            }
          }
        : {})
    }
  );
  logger.info(
    JSON.stringify({
      event: 'membership_worker_quantum',
      request_id: context.awsRequestId,
      message_id: delivery.message_id,
      receive_count: delivery.receive_count,
      target: delivery.hint.target,
      ...result
    })
  );
  if (result.outcome === 'FAILED')
    throw new Error('Membership worker recorded a failed quantum');
  return result;
}

export const handler = wrapLambdaHandler((event, context) =>
  handleMembershipWorkerInvocation(event, context, deployment)
);
