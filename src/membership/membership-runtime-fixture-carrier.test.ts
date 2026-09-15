import type { DataSource, QueryRunner } from 'typeorm';
import type { SqlExecutor } from '@/sql-executor';
import type { MembershipPrimaryContext } from './membership-primary';
import type { FixtureControl } from './membership-runtime-fixture-control';
import { MEMBERSHIP_FIXTURE_DATABASE } from './membership-runtime-policy';

jest.mock('@/db', () => ({
  connect: jest.fn(),
  disconnect: jest.fn(),
  getDataSource: jest.fn()
}));
jest.mock('@/env', () => ({ prepEnvironment: jest.fn() }));
jest.mock('@/redis', () => ({ initRedis: jest.fn() }));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('./membership-primary', () => ({
  ...jest.requireActual('./membership-primary'),
  withMembershipPrimaryTransaction: jest.fn(
    async <T>(
      _db: SqlExecutor,
      fn: (ctx: MembershipPrimaryContext) => Promise<T>
    ) =>
      fn({
        connection: { connection: 'carrier-test-primary' }
      } as unknown as MembershipPrimaryContext)
  )
}));

const actions = {
  preflight: 'membership_runtime_fixture_preflight_v1',
  prepare: 'membership_runtime_fixture_prepare_v1',
  status: 'membership_runtime_fixture_status_v1',
  advance: 'membership_runtime_fixture_advance_v1',
  dbProof: 'membership_runtime_fixture_db_proof_v1',
  cleanup: 'membership_runtime_fixture_cleanup_v1'
} as const;
const environmentNames = [
  'MEMBERSHIP_DIAGNOSTIC_STAGE',
  'AWS_REGION',
  'DB_NAME'
] as const;
const originalEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]])
);
const context = (remaining = 200000) => ({
  awsRequestId: 'fixture-carrier-unit',
  getRemainingTimeInMillis: () => remaining
});
const ready: FixtureControl = {
  revision: '7',
  manifest_hash: 'a'.repeat(64),
  state: {
    setup_stage: 'READY',
    input_page: 3,
    anchor_millis: '1',
    scenario: 'BASELINE',
    transport: null
  }
};
const preparedSchema = {
  ready: true,
  created_tables: 0,
  remaining_tables: 0,
  verified_tables: 21
};

function boot(
  stage: string | null = 'staging',
  region: string | null = 'eu-west-1'
) {
  if (stage === null) delete process.env.MEMBERSHIP_DIAGNOSTIC_STAGE;
  else process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = stage;
  if (region === null) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = region;
  process.env.DB_NAME = 'configured-application';
  let modules: {
    entry: typeof import('@/customReplayLoop/index');
    carrier: typeof import('./membership-runtime-fixture-carrier');
    db: typeof import('@/db');
    env: typeof import('@/env');
    redis: typeof import('@/redis');
    executor: typeof import('@/sql-executor');
    secrets: typeof import('@/secrets');
    primary: typeof import('./membership-primary');
    inspection: typeof import('@/dbMigrationsLoop/membership-additive-schema');
    schema: typeof import('./membership-runtime-fixture-setup-schema');
    setup: typeof import('./membership-runtime-fixture-setup');
    manifest: typeof import('./membership-runtime-fixture-manifest');
    gc: typeof import('./membership-gc-checkpoints.db');
    dispatch: typeof import('./membership-dispatch-checkpoints.db');
    dbProof: typeof import('./membership-runtime-fixture-db-proof');
  };
  jest.isolateModules(() => {
    modules = {
      entry: require('@/customReplayLoop/index'),
      carrier: require('./membership-runtime-fixture-carrier'),
      db: require('@/db'),
      env: require('@/env'),
      redis: require('@/redis'),
      executor: require('@/sql-executor'),
      secrets: require('@/secrets'),
      primary: require('./membership-primary'),
      inspection: require('@/dbMigrationsLoop/membership-additive-schema'),
      schema: require('./membership-runtime-fixture-setup-schema'),
      setup: require('./membership-runtime-fixture-setup'),
      manifest: require('./membership-runtime-fixture-manifest'),
      gc: require('./membership-gc-checkpoints.db'),
      dispatch: require('./membership-dispatch-checkpoints.db'),
      dbProof: require('./membership-runtime-fixture-db-proof')
    };
  });
  const m = modules!;
  const database = { execute: jest.fn() } as unknown as SqlExecutor;
  const source = { isInitialized: true } as DataSource;
  jest.mocked(m.db.connect).mockImplementation(async () => {
    m.executor.setSqlExecutor(database);
  });
  jest.mocked(m.db.getDataSource).mockReturnValue(source);
  const initialize = jest.spyOn(m.secrets, 'doInDbContext');
  const server = {
    selected: null as string | null,
    visible: false,
    grants: ['GRANT CREATE ON *.* TO `fixture-setup`@`%`']
  };
  const query = jest.fn(async (sql: string) => {
    if (sql === 'SELECT DATABASE() selected')
      return [{ selected: server.selected }];
    if (sql.startsWith('SELECT SCHEMA_NAME'))
      return server.visible ? [{ name: MEMBERSHIP_FIXTURE_DATABASE }] : [];
    if (sql === 'SHOW GRANTS FOR CURRENT_USER')
      return server.grants.map((grant) => ({ grants: grant }));
    throw new Error('Unexpected carrier inspection query');
  });
  const inspect = jest
    .spyOn(m.inspection, 'withMembershipSchemaInspection')
    .mockImplementation(async (_source, fn) =>
      fn({
        runner: { query } as unknown as QueryRunner,
        log: async () => ({ upQueries: [], downQueries: [] })
      })
    );
  const create = jest
    .spyOn(m.schema, 'createMembershipFixtureDatabase')
    .mockResolvedValue(undefined);
  const preflight = jest
    .spyOn(m.schema, 'preflightMembershipFixtureSchema')
    .mockResolvedValue({
      ready: true,
      missing_tables: 0,
      metadata_ready: true,
      verified_tables: 21
    });
  const schema = jest
    .spyOn(m.schema, 'prepareMembershipFixtureSchema')
    .mockResolvedValue(preparedSchema);
  const prepare = jest
    .spyOn(m.setup.MembershipFixtureSetupService.prototype, 'prepare')
    .mockResolvedValue(ready);
  const status = jest
    .spyOn(m.setup.MembershipFixtureSetupService.prototype, 'status')
    .mockResolvedValue({ status: 'test-status' } as unknown as Awaited<
      ReturnType<
        InstanceType<typeof m.setup.MembershipFixtureSetupService>['status']
      >
    >);
  const advance = jest
    .spyOn(m.setup.MembershipFixtureSetupService.prototype, 'advance')
    .mockResolvedValue(ready);
  const cleanup = jest
    .spyOn(m.setup.MembershipFixtureSetupService.prototype, 'cleanup')
    .mockResolvedValue(ready);
  const gc = jest
    .spyOn(m.gc.MembershipGcCheckpointsDb.prototype, 'provision')
    .mockResolvedValue(undefined);
  const dispatch = jest
    .spyOn(m.dispatch.MembershipDispatchCheckpointsDb.prototype, 'provision')
    .mockResolvedValue(undefined);
  const dbProof = jest
    .spyOn(m.dbProof.MembershipFixtureDbProofService.prototype, 'run')
    .mockResolvedValue({
      evidence_kind: 'DATABASE_ONLY',
      phase: 'DONE'
    } as unknown as Awaited<
      ReturnType<
        InstanceType<typeof m.dbProof.MembershipFixtureDbProofService>['run']
      >
    >);
  const invoke = m.entry.handler as (
    event: unknown,
    ctx?: ReturnType<typeof context>
  ) => Promise<unknown>;
  return {
    ...m,
    database,
    source,
    initialize,
    server,
    query,
    inspect,
    create,
    preflight,
    schemaPlan: schema,
    prepare,
    status,
    advance,
    cleanup,
    gcProvision: gc,
    dispatchProvision: dispatch,
    proofRun: dbProof,
    invoke
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  for (const [name, value] of Array.from(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('closed fixture carrier through the actual custom replay entry point', () => {
  it('recognizes exactly six one-field actions without exposing arbitrary database, target, SQL or cloud input', async () => {
    const app = boot();
    for (const action of Object.values(actions))
      expect(
        app.carrier.membershipFixtureAction({ operator_action: action })
      ).toBe(action);
    for (const event of [
      { operator_action: 'query' },
      { operator_action: actions.prepare, database: 'application' },
      { operator_action: actions.prepare, sql: 'DROP TABLE identities' },
      { operator_action: actions.advance, profile_id: 'arbitrary' },
      { operator_action: actions.cleanup, queue_url: 'arbitrary' },
      { operator_action: actions.status, source: 'aws.events' },
      {
        Records: [
          { body: JSON.stringify({ operator_action: actions.prepare }) }
        ]
      },
      [{ operator_action: actions.prepare }]
    ]) {
      expect(app.carrier.membershipFixtureAction(event)).toBeNull();
      await expect(app.invoke(event, context())).rejects.toThrow();
    }
    expect(app.initialize).not.toHaveBeenCalled();
    expect(app.env.prepEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    ['prod', 'us-east-1'],
    ['prod', 'eu-west-1'],
    ['staging', 'us-east-1'],
    ['', 'eu-west-1']
  ])(
    'rejects %s/%s at cold admission before secrets or DB',
    async (stage, region) => {
      const app = boot(stage, region);
      // Later process mutation must not activate the cold-start deployment.
      process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'staging';
      process.env.AWS_REGION = 'eu-west-1';
      await expect(
        app.invoke({ operator_action: actions.prepare }, context())
      ).rejects.toThrow('requires staging eu-west-1');
      expect(app.initialize).not.toHaveBeenCalled();
      expect(app.db.connect).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['stage', null, 'eu-west-1'],
    ['region', 'staging', null],
    ['stage and region', null, null]
  ] as const)(
    'rejects all six actions with absent cold-start %s before context, secrets or DB',
    async (_missing, stage, region) => {
      const app = boot(stage, region);
      const invocationContext = {
        awsRequestId: 'fixture-carrier-missing-environment',
        getRemainingTimeInMillis: jest.fn(() => 200000)
      };
      // A later valid environment cannot repair the frozen absent values.
      process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'staging';
      process.env.AWS_REGION = 'eu-west-1';

      for (const action of Object.values(actions)) {
        await expect(
          app.invoke({ operator_action: action }, invocationContext)
        ).rejects.toThrow('Membership fixture requires staging eu-west-1');
      }

      for (const untouched of [
        invocationContext.getRemainingTimeInMillis,
        app.initialize,
        app.env.prepEnvironment,
        app.db.connect,
        app.db.getDataSource,
        app.redis.initRedis,
        app.primary.withMembershipPrimaryTransaction,
        app.inspect,
        app.create,
        app.preflight,
        app.schemaPlan,
        app.prepare,
        app.status,
        app.advance,
        app.cleanup,
        app.gcProvision,
        app.dispatchProvision,
        app.proofRun
      ]) {
        expect(untouched).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['prepare', 179999],
    ['dbProof', 179999],
    ['status', 44999],
    ['preflight', Number.NaN],
    ['cleanup', Infinity]
  ] as const)(
    'rejects %s with insufficient finite budget before connecting',
    async (action, remaining) => {
      const app = boot();
      await expect(
        app.invoke({ operator_action: actions[action] }, context(remaining))
      ).rejects.toThrow('invocation budget');
      expect(app.initialize).not.toHaveBeenCalled();
    }
  );

  it('preflights a missing fixture with one server-only connection and no writes', async () => {
    const app = boot();
    await expect(
      app.invoke({ operator_action: actions.preflight }, context())
    ).resolves.toEqual({
      application_database_distinct: true,
      fixture_visible: false,
      create_database_grant_observed: true,
      schema: null,
      normal_membership_work: 'unavailable'
    });
    expect(app.db.connect).toHaveBeenCalledWith([], false, {
      database: null,
      failOnInitializationError: true
    });
    expect(app.query.mock.calls.map((call) => call[0])).toEqual([
      'SELECT DATABASE() selected',
      expect.stringContaining('information_schema.schemata'),
      'SHOW GRANTS FOR CURRENT_USER'
    ]);
    expect(app.create).not.toHaveBeenCalled();
    expect(app.schemaPlan).not.toHaveBeenCalled();
    expect(app.prepare).not.toHaveBeenCalled();
    expect(app.gcProvision).not.toHaveBeenCalled();
    expect(app.dispatchProvision).not.toHaveBeenCalled();
    expect(app.database.execute).not.toHaveBeenCalled();
    expect(app.redis.initRedis).not.toHaveBeenCalled();
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
  });

  it('preflights an existing fixed fixture with isolated schema metadata and never creates missing objects', async () => {
    const app = boot();
    app.server.visible = true;
    app.server.grants = [
      'GRANT SELECT ON `membership_runtime_drill_v1`.* TO `fixture-setup`@`%`'
    ];
    expect(
      await app.invoke({ operator_action: actions.preflight }, context())
    ).toMatchObject({
      fixture_visible: true,
      create_database_grant_observed: false,
      schema: { ready: true }
    });
    expect(app.db.connect).toHaveBeenNthCalledWith(
      2,
      app.manifest.membershipFixtureEntities,
      false,
      { database: MEMBERSHIP_FIXTURE_DATABASE, failOnInitializationError: true }
    );
    expect(app.preflight).toHaveBeenCalledWith(app.source, {
      stage: 'staging',
      region: 'eu-west-1'
    });
    expect(app.create).not.toHaveBeenCalled();
    expect(app.schemaPlan).not.toHaveBeenCalled();
    expect(app.prepare).not.toHaveBeenCalled();
    expect(app.db.disconnect).toHaveBeenCalledTimes(2);
  });

  it('refuses an application-selected server connection and invalid application/privilege inspection data', async () => {
    const app = boot();
    app.server.selected = 'configured-application';
    await expect(
      app.invoke({ operator_action: actions.prepare }, context())
    ).rejects.toThrow('server-only');
    expect(app.create).not.toHaveBeenCalled();
    app.server.selected = null;
    process.env.DB_NAME = MEMBERSHIP_FIXTURE_DATABASE;
    await expect(
      app.invoke({ operator_action: actions.preflight }, context())
    ).rejects.toThrow('distinct');
    process.env.DB_NAME = 'configured-application';
    app.server.grants = ['x'.repeat(8193)];
    await expect(
      app.invoke({ operator_action: actions.preflight }, context())
    ).rejects.toThrow('privilege inspection');
  });

  it('does one bounded schema quantum and stops before data/setup if schema is incomplete', async () => {
    const app = boot();
    app.schemaPlan.mockResolvedValueOnce({
      ready: false,
      created_tables: 4,
      remaining_tables: 17,
      verified_tables: 0
    });
    expect(
      await app.invoke({ operator_action: actions.prepare }, context())
    ).toMatchObject({
      schema: { ready: false, created_tables: 4 },
      setup: null
    });
    expect(app.create).toHaveBeenCalledWith(
      app.source,
      { stage: 'staging', region: 'eu-west-1' },
      'configured-application'
    );
    expect(app.schemaPlan).toHaveBeenCalledTimes(1);
    expect(app.prepare).not.toHaveBeenCalled();
    expect(app.gcProvision).not.toHaveBeenCalled();
    expect(app.dispatchProvision).not.toHaveBeenCalled();
  });

  it.each(['PROVISIONED', 'READY'] as const)(
    'binds actual setup/control constructors and provisions runtime cursors only at %s',
    async (stage) => {
      const app = boot();
      app.prepare.mockResolvedValueOnce({
        ...ready,
        state: {
          ...ready.state,
          setup_stage: stage,
          input_page: stage === 'READY' ? 3 : 0
        }
      });
      jest.mocked(app.env.prepEnvironment).mockImplementation(async () => {
        process.env.MEMBERSHIP_DIAGNOSTIC_STAGE = 'prod';
        process.env.AWS_REGION = 'us-east-1';
        process.env.DB_NAME = 'secrets-application';
      });
      await app.invoke({ operator_action: actions.prepare }, context());
      expect(app.prepare).toHaveBeenCalledTimes(1);
      const instance = app.prepare.mock.contexts[0];
      expect(instance).toBeInstanceOf(app.setup.MembershipFixtureSetupService);
      expect(Reflect.get(instance, 'db')).toBe(app.database);
      expect(app.schemaPlan).toHaveBeenCalledWith(app.source, {
        stage: 'staging',
        region: 'eu-west-1'
      });
      expect(
        jest.mocked(app.db.connect).mock.calls.map((call) => call[2])
      ).toEqual([
        { database: null, failOnInitializationError: true },
        {
          database: MEMBERSHIP_FIXTURE_DATABASE,
          failOnInitializationError: true
        }
      ]);
      expect(app.gcProvision).toHaveBeenCalledTimes(stage === 'READY' ? 1 : 0);
      expect(app.dispatchProvision).toHaveBeenCalledTimes(
        stage === 'READY' ? 1 : 0
      );
      if (stage === 'READY') {
        const primary = app.prepare.mock.calls[0][0];
        expect(app.gcProvision).toHaveBeenCalledWith(primary);
        expect(app.dispatchProvision).toHaveBeenCalledWith(primary);
        expect(Reflect.get(app.dispatchProvision.mock.contexts[0], 'db')).toBe(
          app.database
        );
      }
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
    }
  );

  it.each(['status', 'advance', 'cleanup'] as const)(
    'routes %s through exactly one fixed fixture transaction without schema/create/provision',
    async (action) => {
      const app = boot();
      await app.invoke({ operator_action: actions[action] }, context());
      expect(app[action]).toHaveBeenCalledTimes(1);
      expect(app.db.connect).toHaveBeenCalledTimes(1);
      expect(app.db.connect).toHaveBeenCalledWith(
        app.manifest.membershipFixtureEntities,
        false,
        {
          database: MEMBERSHIP_FIXTURE_DATABASE,
          failOnInitializationError: true
        }
      );
      expect(app.create).not.toHaveBeenCalled();
      expect(app.schemaPlan).not.toHaveBeenCalled();
      expect(app.prepare).not.toHaveBeenCalled();
      expect(app.gcProvision).not.toHaveBeenCalled();
      expect(app.dispatchProvision).not.toHaveBeenCalled();
    }
  );

  it('runs the database proof on the fixed database outside a carrier transaction', async () => {
    const app = boot();
    const invocation = context();
    await expect(
      app.invoke({ operator_action: actions.dbProof }, invocation)
    ).resolves.toEqual({
      evidence_kind: 'DATABASE_ONLY',
      phase: 'DONE'
    });
    expect(app.proofRun).toHaveBeenCalledWith(invocation);
    expect(Reflect.get(app.proofRun.mock.contexts[0], 'db')).toBe(app.database);
    expect(app.primary.withMembershipPrimaryTransaction).not.toHaveBeenCalled();
    expect(app.db.connect).toHaveBeenCalledWith(
      app.manifest.membershipFixtureEntities,
      false,
      {
        database: MEMBERSHIP_FIXTURE_DATABASE,
        failOnInitializationError: true
      }
    );
    expect(app.db.disconnect).toHaveBeenCalledTimes(1);
    expect(app.create).not.toHaveBeenCalled();
    expect(app.schemaPlan).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'status', 'advance', 'cleanup'] as const)(
    'removes nested private lease tokens from %s responses without changing durable control',
    async (action) => {
      const app = boot();
      const privateControl = {
        ...ready,
        state: {
          ...ready.state,
          proof: {
            db_runtime: {
              claim: {
                run_id: 'recorded-run',
                lease_token: 'private-proof-token'
              },
              attempts: [
                { lease_token: 'another-private-token', outcome: 'FENCED' }
              ]
            }
          }
        }
      };
      if (action === 'status')
        app.status.mockResolvedValueOnce({
          control: privateControl
        } as unknown as Awaited<
          ReturnType<
            InstanceType<
              typeof app.setup.MembershipFixtureSetupService
            >['status']
          >
        >);
      else
        app[action].mockResolvedValueOnce(
          privateControl as unknown as FixtureControl
        );
      const result = await app.invoke(
        { operator_action: actions[action] },
        context()
      );
      const encoded = JSON.stringify(result);
      expect(encoded).not.toContain('lease_token');
      expect(encoded).not.toContain('private-proof-token');
      expect(encoded).not.toContain('another-private-token');
      expect(encoded).toContain('recorded-run');
      expect(encoded).toContain('FENCED');
      expect(privateControl.state.proof.db_runtime.claim.lease_token).toBe(
        'private-proof-token'
      );
    }
  );

  it('disconnects and propagates failed setup/provisioning without a ready result', async () => {
    const app = boot();
    app.dispatchProvision.mockRejectedValueOnce(
      new Error('dispatch cursor integrity')
    );
    await expect(
      app.invoke({ operator_action: actions.prepare }, context())
    ).rejects.toThrow('dispatch cursor integrity');
    expect(app.db.disconnect).toHaveBeenCalledTimes(2);
  });
});
