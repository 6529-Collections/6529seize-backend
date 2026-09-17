import { performance } from 'node:perf_hooks';
import type { MembershipPrimaryContext } from '@/membership/membership-primary';
import type { SqlExecutor } from '@/sql-executor';
import type { MembershipRuntimeEnvironment } from '@/membership/membership-runtime-policy';
import type { MembershipWorkerResult } from '@/membership/membership-worker.types';

jest.mock('@/db', () => ({ connect: jest.fn(), disconnect: jest.fn() }));
jest.mock('@/env', () => ({ prepEnvironment: jest.fn() }));
jest.mock('@/redis', () => ({ initRedis: jest.fn() }));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
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
jest.mock('@/membership/membership-bootstrap.db', () => ({
  requireMembershipBootstrapReady: jest.fn(async () => ({ stage: 'COMPLETE' }))
}));

const staging = {
  stage: 'staging',
  region: 'eu-west-1',
  mode: 'staging-fixture-v1',
  queue_arn:
    'arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1',
  queue_url:
    'https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1'
};
const status = { operator_action: 'membership_runtime_status_v1' };
const hint = {
  protocol_version: 1,
  target: { scope: 'PROFILE', target_id: 'membership-drill-long-v1' },
  delivery: {
    requested_version: '9007199254740993',
    reserved_until_millis: '1789490000000'
  }
};
const event = () => ({
  Records: [
    {
      eventSource: 'aws:sqs',
      eventSourceARN: staging.queue_arn,
      awsRegion: staging.region,
      messageId: '019946b3-4180-7000-8000-000000000001',
      body: JSON.stringify(hint),
      attributes: { ApproximateReceiveCount: '2' }
    }
  ]
});
const context = (remaining = 60000) => ({
  awsRequestId: 'membership-unit-invocation',
  getRemainingTimeInMillis: () => remaining
});
const result: MembershipWorkerResult = {
  outcome: 'PENDING',
  run_id: 'fixture-run',
  checkpoint_version: '2',
  quanta: 1,
  processed_count: '2',
  query_count: 3,
  input_rows: 2
};
const envNames = [
  'MEMBERSHIP_RUNTIME_STAGE',
  'AWS_REGION',
  'MEMBERSHIP_RUNTIME_MODE',
  'MEMBERSHIP_WORK_QUEUE_ARN',
  'MEMBERSHIP_WORK_QUEUE_URL'
] as const;
const originalEnvironment = new Map(
  envNames.map((key) => [key, process.env[key]])
);
function setEnvironment(value: MembershipRuntimeEnvironment) {
  const values = [
    value.stage,
    value.region,
    value.mode,
    value.queue_arn,
    value.queue_url
  ];
  envNames.forEach((name, index) => {
    const value = values[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
}
function boot(environment: MembershipRuntimeEnvironment = staging) {
  setEnvironment(environment);
  let modules: {
    entry: typeof import('./index');
    db: typeof import('@/db');
    env: typeof import('@/env');
    secrets: typeof import('@/secrets');
    redis: typeof import('@/redis');
    primary: typeof import('@/membership/membership-primary');
    worker: typeof import('@/membership/membership-worker');
    evaluator: typeof import('@/membership/membership-profile-evaluator');
    fixture: typeof import('@/membership/membership-runtime-fixture.db');
    executor: typeof import('@/sql-executor');
    transport: typeof import('@/membership/membership-runtime-transport.db');
  };
  jest.isolateModules(() => {
    modules = {
      entry: require('./index'),
      db: require('@/db'),
      env: require('@/env'),
      secrets: require('@/secrets'),
      redis: require('@/redis'),
      primary: require('@/membership/membership-primary'),
      worker: require('@/membership/membership-worker'),
      evaluator: require('@/membership/membership-profile-evaluator'),
      fixture: require('@/membership/membership-runtime-fixture.db'),
      executor: require('@/sql-executor'),
      transport: require('@/membership/membership-runtime-transport.db')
    };
  });
  const m = modules!;
  const database = { execute: jest.fn() } as unknown as SqlExecutor;
  jest.mocked(m.db.connect).mockImplementation(async () => {
    m.executor.setSqlExecutor(database);
    return undefined;
  });
  const initialize = jest.spyOn(m.secrets, 'doInDbContext');
  const marker = jest
    .spyOn(
      m.fixture.MembershipRuntimeFixtureDb.prototype,
      'assertOwnedDatabase'
    )
    .mockResolvedValue(undefined);
  const work = jest
    .spyOn(m.worker.MembershipRefreshWorker.prototype, 'runTarget')
    .mockResolvedValue(result);
  const inspect = jest
    .spyOn(
      m.transport.MembershipRuntimeTransportDb.prototype,
      'inspectDelivery'
    )
    .mockResolvedValue({ outcome: 'PROCEED', receipt: null });
  const invoke = m.entry.handler as (
    event: unknown,
    lambdaContext?: ReturnType<typeof context>
  ) => Promise<unknown>;
  return { ...m, database, initialize, marker, work, inspect, invoke };
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Array.from(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('membership worker handler cold-start boundary', () => {
  it.each(['staging', 'prod'] as const)(
    'reports minimal %s inactivity without context, secrets or DB initialization',
    async (stage) => {
      const region = stage === 'staging' ? 'eu-west-1' : 'us-east-1';
      const runtime = {
        stage,
        region,
        mode: 'inactive',
        queue_arn: `arn:aws:sqs:${region}:987989283142:membership-refresh-work-${stage}-v1`,
        queue_url: `https://sqs.${region}.amazonaws.com/987989283142/membership-refresh-work-${stage}-v1`
      };
      const app = boot(runtime);
      await expect(app.invoke(status)).resolves.toEqual({
        service: 'membershipRefreshLoop',
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
        queue_arn: runtime.queue_arn
      });
      await expect(app.invoke(event(), context())).rejects.toThrow('inactive');
      expect(app.initialize).not.toHaveBeenCalled();
      expect(app.env.prepEnvironment).not.toHaveBeenCalled();
      expect(app.db.connect).not.toHaveBeenCalled();
    }
  );
  it.each([
    { stage: 'prod', region: 'us-east-1' },
    { region: 'us-east-1' },
    { mode: 'active' },
    { queue_arn: staging.queue_arn + '-other' }
  ])(
    'rejects invalid cold-start configuration before any secrets or DB access: %j',
    async (change) => {
      const app = boot({ ...staging, ...change });
      await expect(app.invoke(status)).rejects.toThrow(
        'Invalid membership runtime'
      );
      expect(app.initialize).not.toHaveBeenCalled();
      expect(app.env.prepEnvironment).not.toHaveBeenCalled();
    }
  );
  it('does not activate a cold-start inactive function after environment mutation', async () => {
    const app = boot({ ...staging, mode: 'inactive' });
    setEnvironment(staging);
    await expect(app.invoke(event(), context())).rejects.toThrow('inactive');
    expect(app.initialize).not.toHaveBeenCalled();
  });
  it('uses the application database for a controlled staging delivery', async () => {
    const app = boot({ ...staging, mode: 'staging-controlled-v1' });
    const incoming = event();
    incoming.Records[0].body = JSON.stringify({
      ...hint,
      target: { scope: 'PROFILE', target_id: 'real-profile-id' }
    });
    await expect(app.invoke(incoming, context())).resolves.toEqual(result);
    expect(app.marker).not.toHaveBeenCalled();
    expect(app.inspect).not.toHaveBeenCalled();
    expect(app.initialize.mock.calls[0][1]).not.toHaveProperty(
      'databaseSelection'
    );
    expect(app.work).toHaveBeenCalledWith(
      { scope: 'PROFILE', target_id: 'real-profile-id' },
      expect.any(Object),
      {},
      hint.delivery
    );
  });
  it.each([
    { scope: 'FULL', target_id: '*' },
    { scope: 'GROUP', target_id: 'membership-drill-group-001' }
  ])(
    'bounds $scope fanout to one profile per external delivery',
    async (target) => {
      const app = boot();
      const incoming = event();
      incoming.Records[0].body = JSON.stringify({ ...hint, target });
      await expect(app.invoke(incoming, context())).resolves.toEqual(result);
      expect(app.work).toHaveBeenCalledWith(
        target,
        expect.objectContaining({ max_quanta: 1, page_size: 1 }),
        {},
        hint.delivery
      );
    }
  );
  it('retains trusted controls through prepEnvironment overwrites and binds real worker/evaluator to the initialized executor', async () => {
    const app = boot();
    jest.mocked(app.env.prepEnvironment).mockImplementation(async () => {
      setEnvironment({
        stage: 'prod',
        region: 'us-east-1',
        mode: 'inactive',
        queue_arn: 'overwritten',
        queue_url: 'overwritten'
      });
    });
    const before = performance.now();
    await expect(app.invoke(event(), context(15000))).resolves.toEqual(result);
    expect(app.db.connect).toHaveBeenCalledWith([], false, {
      database: 'membership_runtime_drill_v1',
      failOnInitializationError: true
    });
    expect(app.redis.initRedis).not.toHaveBeenCalled();
    expect(app.marker).toHaveBeenCalledTimes(1);
    expect(app.primary.withMembershipPrimaryTransaction).toHaveBeenCalledWith(
      app.database,
      expect.any(Function),
      {},
      expect.objectContaining({
        maxStatementMillis: 1000,
        finalizationReserveMillis: 2000,
        lockWaitSeconds: 1
      })
    );
    expect(app.work).toHaveBeenCalledWith(
      hint.target,
      expect.objectContaining({
        max_quanta: 1,
        page_size: 2,
        max_statement_millis: 1000,
        finalization_reserve_millis: 2000,
        checkpoint_reserve_millis: 2000,
        transaction_millis: 15000,
        lease_millis: 90000
      }),
      {},
      hint.delivery
    );
    const options = app.work.mock.calls[0][1];
    expect(options.deadline_monotonic_millis).toBeGreaterThanOrEqual(
      before + 10000
    );
    expect(options.deadline_monotonic_millis).toBeLessThanOrEqual(
      performance.now() + 10000
    );
    const worker = app.work.mock.contexts[0];
    expect(worker).toBeInstanceOf(app.worker.MembershipRefreshWorker);
    expect(Reflect.get(worker, 'db')).toBe(app.database);
    const evaluator = Reflect.get(worker, 'evaluator');
    expect(evaluator).toBeInstanceOf(
      app.evaluator.PrimaryMembershipProfileEvaluator
    );
    expect(Reflect.get(evaluator, 'db')).toBe(app.database);
    expect(app.marker.mock.invocationCallOrder[0]).toBeLessThan(
      app.work.mock.invocationCallOrder[0]
    );
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
    await expect(app.invoke(event(), context())).resolves.toEqual(result);
    expect(app.work).toHaveBeenCalledTimes(2);
    await expect(app.invoke(status)).resolves.toMatchObject({
      stage: 'staging',
      region: 'eu-west-1',
      mode: 'staging-fixture-v1'
    });
  });
  it('refuses malformed delivery and insufficient invocation budget before initialization', async () => {
    const app = boot();
    for (const input of [
      { operator_action: 'membership_runtime_status_v1', extra: true },
      { Records: [] },
      { Records: [{ ...event().Records[0], body: ' '.repeat(2049) }] },
      {
        Records: [
          {
            ...event().Records[0],
            eventSourceARN: staging.queue_arn + '-other'
          }
        ]
      },
      {
        Records: [
          {
            ...event().Records[0],
            body: JSON.stringify({
              ...hint,
              target: { scope: 'PROFILE', target_id: 'live-profile' }
            })
          }
        ]
      }
    ])
      await expect(app.invoke(input, context())).rejects.toThrow();
    for (const remaining of [9999, NaN, Infinity])
      await expect(app.invoke(event(), context(remaining))).rejects.toThrow(
        'invocation budget'
      );
    expect(app.initialize).not.toHaveBeenCalled();
    expect(app.env.prepEnvironment).not.toHaveBeenCalled();
  });
  it('checks fixture ownership before running work and always disconnects on rejection', async () => {
    const app = boot();
    app.marker.mockRejectedValueOnce(new Error('fixture marker mismatch'));
    await expect(app.invoke(event(), context())).rejects.toThrow(
      'fixture marker mismatch'
    );
    expect(app.work).not.toHaveBeenCalled();
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
  it('throws for failed durable work so SQS does not acknowledge the failing delivery', async () => {
    const app = boot();
    app.work.mockResolvedValueOnce({ ...result, outcome: 'FAILED' });
    await expect(app.invoke(event(), context())).rejects.toThrow(
      'failed quantum'
    );
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
  it('checks transport before and after a pending committed quantum', async () => {
    const app = boot();
    await app.invoke(event(), context());
    expect(app.inspect).toHaveBeenNthCalledWith(
      1,
      hint.target,
      event().Records[0].messageId,
      null,
      expect.any(Object)
    );
    expect(app.inspect).toHaveBeenNthCalledWith(
      2,
      hint.target,
      event().Records[0].messageId,
      result,
      expect.any(Object)
    );
    expect(app.inspect.mock.invocationCallOrder[0]).toBeLessThan(
      app.work.mock.invocationCallOrder[0]
    );
    expect(app.work.mock.invocationCallOrder[0]).toBeLessThan(
      app.inspect.mock.invocationCallOrder[1]
    );
  });
  it.each([false, true])(
    'throws a held-message transport failure only after receipt transaction commit (after page=%s)',
    async (afterPage) => {
      const app = boot();
      const timeline: string[] = [];
      jest
        .mocked(app.primary.withMembershipPrimaryTransaction)
        .mockImplementation(async (_db, callback) => {
          const value = await callback({
            connection: { connection: 'bound-test-primary' }
          } as unknown as MembershipPrimaryContext);
          timeline.push('commit');
          return value;
        });
      if (afterPage)
        app.inspect.mockResolvedValueOnce({
          outcome: 'PROCEED',
          receipt: null
        });
      app.inspect.mockImplementationOnce(async () => {
        timeline.push('receipt');
        return {
          outcome: 'HELD_MESSAGE',
          receipt: {
            phase: 'HELD',
            message_id: event().Records[0].messageId,
            run_id: '019946b3-4180-7000-8000-000000000002',
            checkpoint_version: '2'
          }
        };
      });
      await app.invoke(event(), context()).then(
        () => {
          throw new Error('Expected held receipt');
        },
        (error) => {
          timeline.push('rejected');
          expect(error.message).toContain('committed checkpoint');
        }
      );
      expect(timeline.slice(-3)).toEqual(['receipt', 'commit', 'rejected']);
      expect(app.work).toHaveBeenCalledTimes(afterPage ? 1 : 0);
      expect(app.db.disconnect).toHaveBeenCalledTimes(1);
    }
  );
  it('acknowledges a different held-target hint without running another quantum', async () => {
    const app = boot();
    app.inspect.mockResolvedValueOnce({
      outcome: 'OTHER_MESSAGE',
      receipt: {
        phase: 'HELD',
        message_id: '019946b3-4180-7000-8000-000000000003',
        run_id: '019946b3-4180-7000-8000-000000000002',
        checkpoint_version: '2'
      }
    });
    await expect(app.invoke(event(), context())).resolves.toMatchObject({
      outcome: 'NO_WORK',
      quanta: 0
    });
    expect(app.work).not.toHaveBeenCalled();
    expect(app.inspect).toHaveBeenCalledTimes(1);
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
  it('does not acknowledge an uncertain receipt commit or failed readiness check', async () => {
    const app = boot();
    app.inspect.mockRejectedValueOnce(new Error('receipt commit unknown'));
    await expect(app.invoke(event(), context())).rejects.toThrow(
      'receipt commit unknown'
    );
    expect(app.work).not.toHaveBeenCalled();
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });
});
