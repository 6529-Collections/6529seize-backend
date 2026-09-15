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
import { withMembershipPrimaryTransaction } from '@/membership/membership-primary';
import { MembershipRuntimeFixtureDb } from '@/membership/membership-runtime-fixture.db';
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
  queue_arn: process.env.MEMBERSHIP_WORK_QUEUE_ARN,
  queue_url: process.env.MEMBERSHIP_WORK_QUEUE_URL
});

function workerOptions(
  context: Pick<Context, 'getRemainingTimeInMillis'>
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
    page_size: 2,
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
      normal_membership_work: 'unavailable',
      queue_arn: runtime.queue_arn
    };
  }
  const delivery = parseMembershipWorkerDelivery(event, runtime);
  const options = workerOptions(context);
  const result = await doInDbContext(
    async () => {
      await withMembershipPrimaryTransaction(
        sqlExecutor,
        (primary) =>
          new MembershipRuntimeFixtureDb(sqlExecutor).assertOwnedDatabase(
            primary
          ),
        {},
        membershipWorkerBudget(options)
      );
      return new MembershipRefreshWorker(
        sqlExecutor,
        new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
      ).runTarget(delivery.hint.target, options, {}, delivery.hint.delivery);
    },
    {
      logger,
      entities: [],
      syncEntities: false,
      skipRedis: true,
      databaseSelection: {
        database: MEMBERSHIP_FIXTURE_DATABASE,
        failOnInitializationError: true
      }
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
