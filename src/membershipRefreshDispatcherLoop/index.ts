import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { wrapLambdaHandler } from '@/sentry.context';
import { sqlExecutor } from '@/sql-executor';
import { withMembershipPrimaryTransaction } from '@/membership/membership-primary';
import { MembershipRefreshDispatcher } from '@/membership/membership-dispatch';
import type {
  MembershipDispatchResult,
  MembershipDispatchSender
} from '@/membership/membership-dispatch.types';
import { MembershipRuntimeSendFaultDb } from '@/membership/membership-runtime-send-fault.db';
import { MembershipRunGarbageCollector } from '@/membership/membership-gc';
import type { MembershipWorkerOptions } from '@/membership/membership-worker.types';
import {
  assertMembershipFixtureReady,
  MembershipRuntimeTransportDb
} from '@/membership/membership-runtime-transport.db';
import {
  MEMBERSHIP_FIXTURE_DATABASE,
  MEMBERSHIP_FIXTURE_PROFILES,
  isMembershipRuntimeStatus
} from '@/membership/membership-runtime-policy';
import type { FixtureControl } from '@/membership/membership-runtime-fixture-control';
import {
  MembershipDispatchEnvironment,
  parseMembershipScheduledEvent,
  validateMembershipDispatchDeployment
} from '@/membership/membership-runtime-dispatch-policy';
import {
  createMembershipQueueSender,
  MembershipQueueCredentials
} from '@/membership/membership-runtime-sqs';

const logger = Logger.get('MEMBERSHIP_REFRESH_DISPATCHER');
const deployment = Object.freeze({
  stage: process.env.MEMBERSHIP_RUNTIME_STAGE,
  region: process.env.AWS_REGION,
  mode: process.env.MEMBERSHIP_RUNTIME_MODE,
  queue_arn: process.env.MEMBERSHIP_WORK_QUEUE_ARN,
  queue_url: process.env.MEMBERSHIP_WORK_QUEUE_URL,
  rule_arn: process.env.MEMBERSHIP_DISPATCH_RULE_ARN,
  schedule_enabled: process.env.MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED
});
// Lambda's execution credentials must not be replaced by mutable shared configuration.
const queueCredentials = Object.freeze({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN
});

function gcExecution(until: number): MembershipWorkerOptions {
  return {
    deadline_monotonic_millis: until,
    transaction_millis: 2000,
    max_statement_millis: 500,
    finalization_reserve_millis: 400,
    checkpoint_reserve_millis: 300,
    lock_wait_seconds: 1,
    lease_millis: 90000,
    max_quanta: 1,
    page_size: 2,
    input_limits: {
      max_queries: 300,
      max_input_rows: 100000,
      max_input_bytes: 8000000,
      max_windows: 100,
      raw_window: 128
    },
    retry_millis: 60000,
    max_attempts: 3
  };
}

function emitMetrics(
  stage: string,
  dispatch: MembershipDispatchResult | null,
  gcProgress: number,
  gcFailures: number
): void {
  const values = {
    DispatchHeartbeat:
      dispatch !== null &&
      dispatch.send_failed === 0 &&
      !dispatch.control_busy &&
      !dispatch.budget_exhausted &&
      gcFailures === 0
        ? 1
        : 0,
    DispatchFailedSends: dispatch?.send_failed ?? 0,
    DispatchControlBusy: Number(dispatch?.control_busy ?? false),
    DispatchBudgetExhausted: Number(dispatch?.budget_exhausted ?? false),
    DispatchOldestDueAgeSeconds: (dispatch?.oldest_due_age_millis ?? 0) / 1000,
    DispatchParkedTargets: dispatch?.parked_seen ?? 0,
    GarbageCollectionProgress: gcProgress,
    GarbageCollectionFailures: gcFailures
  };
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Membership/Runtime',
            Dimensions: [['Stage', 'Service']],
            Metrics: Object.keys(values).map((Name) => ({
              Name,
              Unit: Name.endsWith('Seconds') ? 'Seconds' : 'Count'
            }))
          }
        ]
      },
      Stage: stage,
      Service: 'membershipRefreshDispatcherLoop',
      ...values
    })}\n`
  );
}

function fixtureSender(
  fixture: FixtureControl,
  send: MembershipDispatchSender,
  invocation: { request_id: string; event_id: string }
): MembershipDispatchSender {
  if (
    fixture.state.scenario !== 'MISSED_WAKEUP' ||
    fixture.state.dispatch_send_failure
  )
    return send;
  return async (hint, sendContext) => {
    if (
      hint.target.scope !== 'PROFILE' ||
      hint.target.target_id !== MEMBERSHIP_FIXTURE_PROFILES[0]
    )
      return send(hint, sendContext);
    const fail = await withMembershipPrimaryTransaction(
      sqlExecutor,
      (primary) =>
        new MembershipRuntimeSendFaultDb(sqlExecutor).recordOnce(hint, primary),
      {},
      {
        deadlineMonotonicMillis: Math.min(
          sendContext.deadline_monotonic_millis,
          performance.now() + 800
        ),
        maxStatementMillis: 200,
        finalizationReserveMillis: 200,
        lockWaitSeconds: 1
      }
    );
    if (!fail) return send(hint, sendContext);
    logger.info(
      JSON.stringify({
        event: 'membership_fixture_dispatch_send_failure',
        ...invocation,
        target: hint.target,
        delivery: hint.delivery
      })
    );
    throw new Error(
      'Membership fixture withheld one send after committed reservation'
    );
  };
}

export async function handleMembershipDispatcherInvocation(
  event: unknown,
  context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  environment: MembershipDispatchEnvironment,
  credentials: MembershipQueueCredentials
) {
  const runtime = validateMembershipDispatchDeployment(environment);
  if (isMembershipRuntimeStatus(event))
    return {
      service: 'membershipRefreshDispatcherLoop',
      stage: runtime.stage,
      region: runtime.region,
      mode: runtime.mode,
      source_tracking_control: 'per-producer',
      source_readiness: 'unverified',
      materialized_read_control: 'api-separate',
      background_processing_mode: runtime.mode,
      background_processing_code_admission:
        runtime.mode === 'staging-controlled-v1' ? 'controlled' : 'unavailable',
      background_processing_trigger_enabled: runtime.schedule_enabled,
      normal_membership_work:
        runtime.mode === 'staging-controlled-v1' ? 'unverified' : 'unavailable',
      queue_arn: runtime.queue_arn,
      rule_arn: runtime.rule_arn,
      schedule_enabled: runtime.schedule_enabled
    };
  const tick = parseMembershipScheduledEvent(event, runtime);
  const remaining = context.getRemainingTimeInMillis();
  if (!Number.isFinite(remaining) || remaining < 15000)
    throw new Error('Insufficient membership dispatcher invocation budget');
  const until = performance.now() + Math.min(25000, remaining - 5000);
  const dispatchUntil = until - 7000;
  const sender = createMembershipQueueSender(
    runtime,
    credentials,
    { request_id: context.awsRequestId, event_id: tick.event_id },
    logger
  );
  try {
    return await doInDbContext(
      async () => {
        const fixture =
          runtime.mode === 'staging-fixture-v1'
            ? await withMembershipPrimaryTransaction(
                sqlExecutor,
                (primary) => assertMembershipFixtureReady(sqlExecutor, primary),
                {},
                {
                  deadlineMonotonicMillis: Math.min(
                    dispatchUntil,
                    performance.now() + 2000
                  ),
                  maxStatementMillis: 500,
                  finalizationReserveMillis: 400,
                  lockWaitSeconds: 1
                }
              )
            : null;
        let dispatch: MembershipDispatchResult | null = null;
        let gcProgress = 0;
        let gcFailures = 0;
        let dispatchError: unknown;
        let dispatchFailed = false;
        try {
          const transport = fixture
            ? new MembershipRuntimeTransportDb(sqlExecutor)
            : null;
          const send = fixture
            ? fixtureSender(fixture, sender.send, {
                request_id: context.awsRequestId,
                event_id: tick.event_id
              })
            : sender.send;
          dispatch = await new MembershipRefreshDispatcher(
            sqlExecutor,
            send,
            transport
              ? (target, primary) => transport.heldTarget(target, primary)
              : undefined
          ).run({
            deadline_monotonic_millis: dispatchUntil,
            control_millis: 2000,
            target_millis: 2000,
            send_millis: 1000,
            cleanup_reserve_millis: 500,
            max_statement_millis: 500,
            finalization_reserve_millis: 400,
            lock_wait_seconds: 1,
            reservation_millis: 120000,
            max_candidates: 40,
            max_per_lane: 20
          });
        } catch (error) {
          dispatchFailed = true;
          dispatchError = error;
        }
        try {
          const gc = await new MembershipRunGarbageCollector(sqlExecutor).run(
            {
              reader_grace_millis: 120000,
              scan_age_millis: 120000,
              member_batch: 128,
              pending_claim_millis: 90000,
              max_attempts: 2
            },
            gcExecution(until)
          );
          gcProgress = gc.reduce((sum, item) => sum + item.deleted_count, 0);
          logger.info(
            JSON.stringify({
              event: 'membership_dispatch_tick',
              request_id: context.awsRequestId,
              ...tick,
              dispatch,
              gc
            })
          );
        } catch (error) {
          gcFailures = 1;
          if (!dispatchFailed) throw error;
        } finally {
          emitMetrics(runtime.stage, dispatch, gcProgress, gcFailures);
        }
        if (dispatchFailed) throw dispatchError;
        return { dispatch, gc_deleted_members: gcProgress };
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
  } finally {
    sender.close();
  }
}

export const handler = wrapLambdaHandler((event, context) =>
  handleMembershipDispatcherInvocation(
    event,
    context,
    deployment,
    queueCredentials
  )
);
