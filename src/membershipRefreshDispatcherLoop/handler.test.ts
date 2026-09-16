import { performance } from 'node:perf_hooks';
import type { MembershipPrimaryContext } from '@/membership/membership-primary';
import type { SqlExecutor } from '@/sql-executor';
import type { MembershipDispatchEnvironment } from '@/membership/membership-runtime-dispatch-policy';
import type {
  MembershipDispatchResult,
  MembershipDispatchSender
} from '@/membership/membership-dispatch.types';
import { MEMBERSHIP_FIXTURE_PROFILES } from '@/membership/membership-runtime-policy';

jest.mock('@/db', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('@/env', () => ({ prepEnvironment: jest.fn() }));
jest.mock('@/redis', () => ({ initRedis: jest.fn() }));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('@/membership/membership-runtime-sqs', () => ({
  createMembershipQueueSender: jest.fn(() => ({
    send: jest.fn(),
    close: jest.fn()
  }))
}));
jest.mock('@/membership/membership-primary', () => ({
  ...jest.requireActual('@/membership/membership-primary'),
  withMembershipPrimaryTransaction: jest.fn(
    async <T>(
      _db: SqlExecutor,
      callback: (ctx: MembershipPrimaryContext) => Promise<T>
    ) =>
      callback({
        connection: { connection: 'bound-test-primary' }
      } as unknown as MembershipPrimaryContext)
  )
}));
const staging = {
  stage: 'staging',
  region: 'eu-west-1',
  mode: 'staging-fixture-v1',
  queue_arn:
    'arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1',
  queue_url:
    'https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1',
  rule_arn:
    'arn:aws:events:eu-west-1:987989283142:rule/membership-refresh-dispatch-staging-v1',
  schedule_enabled: 'true'
};
const credentials = {
  accessKeyId: 'fixture-access',
  secretAccessKey: 'fixture-secret',
  sessionToken: 'fixture-session'
};
const status = { operator_action: 'membership_runtime_status_v1' };
const event = () => ({
  version: '0',
  id: '019946b3-4180-7000-8000-000000000001',
  'detail-type': 'Scheduled Event',
  source: 'aws.events',
  account: '987989283142',
  time: new Date().toISOString(),
  region: staging.region,
  resources: [staging.rule_arn],
  detail: {}
});
const context = (remaining = 30000) => ({
  awsRequestId: 'fixture-request',
  getRemainingTimeInMillis: () => remaining
});
const dispatchResult: MembershipDispatchResult = {
  raw_candidates: 0,
  due_candidates: 0,
  target_pk_candidates: 0,
  sent: 0,
  skipped: 0,
  send_failed: 0,
  control_busy: false,
  budget_exhausted: false,
  oldest_due_age_millis: 0,
  parked_seen: 0,
  outcomes: {}
};
const envNames = [
  'MEMBERSHIP_RUNTIME_STAGE',
  'AWS_REGION',
  'MEMBERSHIP_RUNTIME_MODE',
  'MEMBERSHIP_WORK_QUEUE_ARN',
  'MEMBERSHIP_WORK_QUEUE_URL',
  'MEMBERSHIP_DISPATCH_RULE_ARN',
  'MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
] as const;
const originalEnvironment = new Map(
  envNames.map((key) => [key, process.env[key]])
);
function setEnvironment(environment: MembershipDispatchEnvironment) {
  const values = [
    environment.stage,
    environment.region,
    environment.mode,
    environment.queue_arn,
    environment.queue_url,
    environment.rule_arn,
    environment.schedule_enabled,
    credentials.accessKeyId,
    credentials.secretAccessKey,
    credentials.sessionToken
  ];
  envNames.forEach((key, index) => {
    const value = values[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
}
function boot(environment: MembershipDispatchEnvironment = staging) {
  setEnvironment(environment);
  let modules: {
    entry: typeof import('./index');
    db: typeof import('@/db');
    env: typeof import('@/env');
    secrets: typeof import('@/secrets');
    redis: typeof import('@/redis');
    executor: typeof import('@/sql-executor');
    primary: typeof import('@/membership/membership-primary');
    dispatch: typeof import('@/membership/membership-dispatch');
    gc: typeof import('@/membership/membership-gc');
    transport: typeof import('@/membership/membership-runtime-transport.db');
    sendFault: typeof import('@/membership/membership-runtime-send-fault.db');
    sqs: typeof import('@/membership/membership-runtime-sqs');
  };
  jest.isolateModules(() => {
    modules = {
      entry: require('./index'),
      db: require('@/db'),
      env: require('@/env'),
      secrets: require('@/secrets'),
      redis: require('@/redis'),
      executor: require('@/sql-executor'),
      primary: require('@/membership/membership-primary'),
      dispatch: require('@/membership/membership-dispatch'),
      gc: require('@/membership/membership-gc'),
      transport: require('@/membership/membership-runtime-transport.db'),
      sendFault: require('@/membership/membership-runtime-send-fault.db'),
      sqs: require('@/membership/membership-runtime-sqs')
    };
  });
  const m = modules!;
  const database = { execute: jest.fn() } as unknown as SqlExecutor;
  jest.mocked(m.db.connect).mockImplementation(async () => {
    m.executor.setSqlExecutor(database);
    return undefined;
  });
  const initialize = jest.spyOn(m.secrets, 'doInDbContext');
  const ready = jest
    .spyOn(m.transport, 'assertMembershipFixtureReady')
    .mockResolvedValue({
      revision: '1',
      manifest_hash: 'a'.repeat(64),
      state: {
        setup_stage: 'READY',
        input_page: 3,
        anchor_millis: '1',
        scenario: 'BASELINE',
        transport: null
      }
    });
  const dispatch = jest
    .spyOn(m.dispatch.MembershipRefreshDispatcher.prototype, 'run')
    .mockResolvedValue(dispatchResult);
  const gc = jest
    .spyOn(m.gc.MembershipRunGarbageCollector.prototype, 'run')
    .mockResolvedValue([]);
  const held = jest
    .spyOn(m.transport.MembershipRuntimeTransportDb.prototype, 'heldTarget')
    .mockResolvedValue(false);
  const stdout = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  const metrics = () =>
    stdout.mock.calls.flatMap(([value]) => {
      try {
        const data = JSON.parse(String(value));
        return data._aws ? [data] : [];
      } catch {
        return [];
      }
    });
  const invoke = m.entry.handler as (
    event: unknown,
    lambdaContext?: ReturnType<typeof context>
  ) => Promise<unknown>;
  return {
    ...m,
    Dispatcher: m.dispatch.MembershipRefreshDispatcher,
    Collector: m.gc.MembershipRunGarbageCollector,
    database,
    initialize,
    ready,
    dispatch,
    gc,
    held,
    metrics,
    invoke
  };
}
afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Array.from(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('membership dispatcher handler integration boundary', () => {
  it.each(['staging', 'prod'])(
    'returns minimal inactive %s status without credentials, context, DB or secrets',
    async (stage) => {
      const region = stage === 'staging' ? 'eu-west-1' : 'us-east-1';
      const runtime = {
        stage,
        region,
        mode: 'inactive',
        schedule_enabled: 'false',
        queue_arn: `arn:aws:sqs:${region}:987989283142:membership-refresh-work-${stage}-v1`,
        queue_url: `https://sqs.${region}.amazonaws.com/987989283142/membership-refresh-work-${stage}-v1`,
        rule_arn: `arn:aws:events:${region}:987989283142:rule/membership-refresh-dispatch-${stage}-v1`
      };
      const app = boot(runtime);
      await expect(app.invoke(status)).resolves.toEqual({
        service: 'membershipRefreshDispatcherLoop',
        stage,
        region,
        mode: 'inactive',
        source_tracking_control: 'per-producer',
        source_readiness: 'unverified',
        materialized_read_control: 'api-separate',
        background_processing_mode: 'inactive',
        background_processing_code_admission: 'unavailable',
        background_processing_trigger_enabled: false,
        normal_membership_work: 'unavailable',
        queue_arn: runtime.queue_arn,
        rule_arn: runtime.rule_arn,
        schedule_enabled: false
      });
      await expect(app.invoke(event(), context())).rejects.toThrow('inactive');
      expect(app.initialize).not.toHaveBeenCalled();
      expect(app.env.prepEnvironment).not.toHaveBeenCalled();
      expect(app.sqs.createMembershipQueueSender).not.toHaveBeenCalled();
    }
  );
  it.each([
    { stage: 'prod', region: 'us-east-1' },
    { region: 'us-east-1' },
    { mode: 'active' },
    { queue_arn: staging.queue_arn + '-other' },
    { rule_arn: staging.rule_arn + '-other' },
    { schedule_enabled: 'TRUE' }
  ])(
    'rejects invalid cold-start controls before initialization %j',
    async (change) => {
      const app = boot({ ...staging, ...change });
      await expect(app.invoke(status)).rejects.toThrow('Invalid membership');
      expect(app.initialize).not.toHaveBeenCalled();
      expect(app.env.prepEnvironment).not.toHaveBeenCalled();
      expect(app.sqs.createMembershipQueueSender).not.toHaveBeenCalled();
    }
  );
  it('cannot enable an inactive frozen deployment by overwriting process environment', async () => {
    const app = boot({
      ...staging,
      mode: 'inactive',
      schedule_enabled: 'false'
    });
    setEnvironment(staging);
    await expect(app.invoke(event(), context())).rejects.toThrow('inactive');
    expect(app.initialize).not.toHaveBeenCalled();
  });
  it('uses the application database and ordinary dispatcher in controlled staging', async () => {
    const app = boot({ ...staging, mode: 'staging-controlled-v1' });
    await expect(app.invoke(event(), context())).resolves.toEqual({
      dispatch: dispatchResult,
      gc_deleted_members: 0
    });
    expect(app.ready).not.toHaveBeenCalled();
    expect(app.held).not.toHaveBeenCalled();
    expect(app.initialize.mock.calls[0][1]).not.toHaveProperty(
      'databaseSelection'
    );
    expect(app.dispatch).toHaveBeenCalledTimes(1);
  });
  it('retains deployment and credentials across secret overwrites and binds real domain services to the selected executor', async () => {
    const app = boot();
    jest.mocked(app.env.prepEnvironment).mockImplementation(async () => {
      for (const name of envNames) process.env[name] = 'overwritten';
    });
    const before = performance.now();
    await expect(app.invoke(event(), context())).resolves.toEqual({
      dispatch: dispatchResult,
      gc_deleted_members: 0
    });
    const createSender = jest.mocked(app.sqs.createMembershipQueueSender);
    expect(createSender).toHaveBeenCalledWith(
      expect.objectContaining({ ...staging, schedule_enabled: true }),
      credentials,
      expect.objectContaining({ request_id: 'fixture-request' }),
      expect.any(Object)
    );
    expect(Object.isFrozen(createSender.mock.calls[0][1])).toBe(true);
    expect(app.db.connect).toHaveBeenCalledWith([], false, {
      database: 'membership_runtime_drill_v1',
      failOnInitializationError: true
    });
    expect(app.redis.initRedis).not.toHaveBeenCalled();
    const dispatcher = app.dispatch.mock.contexts[0];
    expect(dispatcher).toBeInstanceOf(app.Dispatcher);
    expect(Reflect.get(dispatcher, 'db')).toBe(app.database);
    expect(Reflect.get(dispatcher, 'sender')).toBe(
      createSender.mock.results[0].value.send
    );
    const gc = app.gc.mock.contexts[0];
    expect(gc).toBeInstanceOf(app.Collector);
    expect(Reflect.get(gc, 'db')).toBe(app.database);
    const dispatchOptions = app.dispatch.mock.calls[0][0];
    const gcOptions = app.gc.mock.calls[0][1];
    expect(dispatchOptions).toMatchObject({
      max_candidates: 40,
      max_per_lane: 20,
      send_millis: 1000,
      cleanup_reserve_millis: 500
    });
    expect(
      gcOptions.deadline_monotonic_millis -
        dispatchOptions.deadline_monotonic_millis
    ).toBe(7000);
    expect(gcOptions.deadline_monotonic_millis).toBeGreaterThanOrEqual(
      before + 25000
    );
    expect(app.gc.mock.calls[0][0]).toMatchObject({
      max_attempts: 2,
      member_batch: 128
    });
    expect(app.ready.mock.invocationCallOrder[0]).toBeLessThan(
      app.dispatch.mock.invocationCallOrder[0]
    );
    expect(app.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      app.gc.mock.invocationCallOrder[0]
    );
    expect(app.metrics()).toEqual([
      expect.objectContaining({
        Stage: 'staging',
        Service: 'membershipRefreshDispatcherLoop',
        DispatchHeartbeat: 1,
        DispatchOldestDueAgeSeconds: 0,
        GarbageCollectionProgress: 0
      })
    ]);
    expect(createSender.mock.results[0].value.close).toHaveBeenCalledTimes(1);
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
    // A second warm invocation still uses cold-start identity after shared secrets changed.
    await app.invoke(event(), context());
    expect(createSender.mock.calls[1][1]).toEqual(credentials);
  });
  it('rejects malformed, stale, cross-rule events and insufficient time before sender/DB creation', async () => {
    const app = boot();
    for (const input of [
      { ...status, extra: true },
      { ...event(), resources: [staging.rule_arn + '-other'] },
      { ...event(), region: 'us-east-1' },
      { ...event(), time: new Date(Date.now() - 120001).toISOString() },
      { ...event(), detail: { target: 'untrusted' } }
    ])
      await expect(app.invoke(input, context())).rejects.toThrow();
    for (const remaining of [14999, NaN, Infinity])
      await expect(app.invoke(event(), context(remaining))).rejects.toThrow(
        'invocation budget'
      );
    expect(app.initialize).not.toHaveBeenCalled();
    expect(app.sqs.createMembershipQueueSender).not.toHaveBeenCalled();
  });
  it('refuses an unready fixture before dispatch and GC, closing the dedicated sender', async () => {
    const app = boot();
    app.ready.mockRejectedValueOnce(new Error('fixture not ready'));
    await expect(app.invoke(event(), context())).rejects.toThrow(
      'fixture not ready'
    );
    expect(app.dispatch).not.toHaveBeenCalled();
    expect(app.gc).not.toHaveBeenCalled();
    expect(
      jest.mocked(app.sqs.createMembershipQueueSender).mock.results[0].value
        .close
    ).toHaveBeenCalledTimes(1);
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
  it('runs GC after dispatch failure with its independent budget, emits failed heartbeat, then preserves the original error', async () => {
    const app = boot();
    const failure = new Error('dispatch failed');
    app.dispatch.mockRejectedValueOnce(failure);
    await expect(app.invoke(event(), context())).rejects.toBe(failure);
    expect(app.gc).toHaveBeenCalledTimes(1);
    expect(
      app.gc.mock.calls[0][1].deadline_monotonic_millis -
        app.dispatch.mock.calls[0][0].deadline_monotonic_millis
    ).toBe(7000);
    expect(app.metrics()).toEqual([
      expect.objectContaining({
        DispatchHeartbeat: 0,
        GarbageCollectionFailures: 0
      })
    ]);
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'reports GC failure and preserves dispatch error priority (dispatch failed=%s)',
    async (dispatchFailed) => {
      const app = boot();
      const dispatchFailure = new Error('dispatch failure');
      const gcFailure = new Error('GC failure');
      if (dispatchFailed) app.dispatch.mockRejectedValueOnce(dispatchFailure);
      app.gc.mockRejectedValueOnce(gcFailure);
      await expect(app.invoke(event(), context())).rejects.toBe(
        dispatchFailed ? dispatchFailure : gcFailure
      );
      expect(app.metrics()).toEqual([
        expect.objectContaining({
          DispatchHeartbeat: 0,
          GarbageCollectionFailures: 1
        })
      ]);
    }
  );
  it('emits bounded observations and send failures without claiming a healthy pass', async () => {
    const app = boot();
    app.dispatch.mockResolvedValueOnce({
      ...dispatchResult,
      oldest_due_age_millis: 1250,
      parked_seen: 2,
      send_failed: 1
    });
    app.gc.mockResolvedValueOnce([
      {
        run_id: 'fixture-run',
        outcome: 'PARTIAL',
        read_count: 3,
        deleted_count: 3,
        retry_at_millis: null
      }
    ]);
    await app.invoke(event(), context());
    expect(app.metrics()).toEqual([
      expect.objectContaining({
        DispatchHeartbeat: 0,
        DispatchFailedSends: 1,
        DispatchOldestDueAgeSeconds: 1.25,
        DispatchParkedTargets: 2,
        GarbageCollectionProgress: 3
      })
    ]);
  });
  it.each([
    { control_busy: true, budget_exhausted: false },
    { control_busy: false, budget_exhausted: true },
    { control_busy: true, budget_exhausted: true }
  ])(
    'reports degraded dispatch %j without a healthy heartbeat',
    async (flags) => {
      const app = boot();
      const result = { ...dispatchResult, ...flags };
      app.dispatch.mockResolvedValueOnce(result);
      await expect(app.invoke(event(), context())).resolves.toEqual({
        dispatch: result,
        gc_deleted_members: 0
      });
      expect(app.gc).toHaveBeenCalledTimes(1);
      const metrics = app.metrics();
      expect(metrics).toEqual([
        expect.objectContaining({
          DispatchHeartbeat: 0,
          DispatchFailedSends: 0,
          DispatchControlBusy: Number(flags.control_busy),
          DispatchBudgetExhausted: Number(flags.budget_exhausted),
          GarbageCollectionFailures: 0
        })
      ]);
      expect(metrics[0]._aws.CloudWatchMetrics[0].Metrics).toEqual(
        expect.arrayContaining([
          { Name: 'DispatchControlBusy', Unit: 'Count' },
          { Name: 'DispatchBudgetExhausted', Unit: 'Count' }
        ])
      );
    }
  );
  it('records the controlled send failure before throwing, retains GC, and sends other targets normally', async () => {
    const app = boot();
    const ready = await app.transport.assertMembershipFixtureReady(
      app.database,
      {} as MembershipPrimaryContext
    );
    app.ready.mockResolvedValue({
      ...ready,
      state: { ...ready.state, scenario: 'MISSED_WAKEUP' }
    });
    const order: string[] = [];
    jest
      .mocked(app.primary.withMembershipPrimaryTransaction)
      .mockImplementation(async (_db, callback) => {
        const result = await callback({
          connection: { connection: 'bound-test-primary' }
        } as unknown as MembershipPrimaryContext);
        order.push('committed');
        return result;
      });
    const fault = jest
      .spyOn(app.sendFault.MembershipRuntimeSendFaultDb.prototype, 'recordOnce')
      .mockImplementation(async () => {
        order.push('receipt');
        return true;
      });
    app.dispatch.mockImplementation(async function (
      this: InstanceType<typeof app.Dispatcher>
    ) {
      const send = Reflect.get(this, 'sender') as MembershipDispatchSender;
      const budget = {
        deadline_monotonic_millis: performance.now() + 1000,
        signal: new AbortController().signal
      };
      const hint = {
        target: {
          scope: 'PROFILE' as const,
          target_id: MEMBERSHIP_FIXTURE_PROFILES[0]
        },
        delivery: { requested_version: '3', reserved_until_millis: '1234' }
      };
      await expect(send(hint, budget)).rejects.toThrow(
        'after committed reservation'
      );
      order.push('failure observed');
      await send(
        {
          ...hint,
          target: { ...hint.target, target_id: MEMBERSHIP_FIXTURE_PROFILES[2] }
        },
        budget
      );
      return { ...dispatchResult, send_failed: 1, sent: 1 };
    });
    await app.invoke(event(), context());
    expect(order).toEqual([
      'committed',
      'receipt',
      'committed',
      'failure observed'
    ]);
    expect(fault).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(app.sqs.createMembershipQueueSender).mock.results[0].value
        .send
    ).toHaveBeenCalledTimes(1);
    expect(app.gc).toHaveBeenCalledTimes(1);
    expect(app.metrics()).toEqual([
      expect.objectContaining({ DispatchHeartbeat: 0, DispatchFailedSends: 1 })
    ]);
  });
});
