import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { getDataSource } from '@/db';
import { doInDbContext } from '@/secrets';
import { sqlExecutor } from '@/sql-executor';
import { Logger } from '@/logging';
import { withMembershipSchemaInspection } from '@/dbMigrationsLoop/membership-additive-schema';
import {
  MembershipPrimaryContext,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipFixtureSetupService } from './membership-runtime-fixture-setup';
import { MembershipFixtureDbProofService } from './membership-runtime-fixture-db-proof';
import { membershipFixtureEntities } from './membership-runtime-fixture-manifest';
import { MEMBERSHIP_FIXTURE_DATABASE } from './membership-runtime-policy';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipGcCheckpointsDb } from './membership-gc-checkpoints.db';
import {
  assertMembershipFixtureEnvironment,
  createMembershipFixtureDatabase,
  MembershipFixtureEnvironment,
  preflightMembershipFixtureSchema,
  prepareMembershipFixtureSchema
} from './membership-runtime-fixture-setup-schema';

const actions = [
  'membership_runtime_fixture_preflight_v1',
  'membership_runtime_fixture_prepare_v1',
  'membership_runtime_fixture_status_v1',
  'membership_runtime_fixture_advance_v1',
  'membership_runtime_fixture_db_proof_v1',
  'membership_runtime_fixture_cleanup_v1'
] as const;
type FixtureAction = (typeof actions)[number];
const logger = Logger.get('MEMBERSHIP_FIXTURE_CARRIER');

export function membershipFixtureAction(event: unknown): FixtureAction | null {
  if (
    typeof event !== 'object' ||
    event === null ||
    Array.isArray(event) ||
    Object.keys(event).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(event, 'operator_action')
  )
    return null;
  const action = (event as { operator_action: unknown }).operator_action;
  return typeof action === 'string' && actions.some((item) => item === action)
    ? (action as FixtureAction)
    : null;
}

function primary<T>(
  context: Pick<Context, 'getRemainingTimeInMillis'>,
  work: (primary: MembershipPrimaryContext) => Promise<T>
): Promise<T> {
  const remaining = context.getRemainingTimeInMillis();
  if (!Number.isFinite(remaining) || remaining < 8000)
    throw new Error('Insufficient membership fixture transaction budget');
  return withMembershipPrimaryTransaction(
    sqlExecutor,
    work,
    {},
    {
      deadlineMonotonicMillis:
        performance.now() + Math.min(20000, remaining - 5000),
      maxStatementMillis: 1000,
      finalizationReserveMillis: 2000,
      lockWaitSeconds: 1
    }
  );
}

async function inspectServer() {
  const applicationDatabase = process.env.DB_NAME;
  if (
    !applicationDatabase ||
    applicationDatabase === MEMBERSHIP_FIXTURE_DATABASE
  )
    throw new Error(
      'Fixture must be distinct from the configured application database'
    );
  return withMembershipSchemaInspection(getDataSource(), async ({ runner }) => {
    const selected: { selected: string | null }[] = await runner.query(
      'SELECT DATABASE() selected'
    );
    if (selected.length !== 1 || selected[0].selected !== null)
      throw new Error('Fixture preflight requires a server-only connection');
    const schemas: { name: string }[] = await runner.query(
      'SELECT SCHEMA_NAME name FROM information_schema.schemata WHERE SCHEMA_NAME=? LIMIT 2',
      [MEMBERSHIP_FIXTURE_DATABASE]
    );
    if (
      schemas.length > 1 ||
      schemas.some((schema) => schema.name !== MEMBERSHIP_FIXTURE_DATABASE)
    )
      throw new Error('Unexpected fixture schema identity');
    const grants: Record<string, unknown>[] = await runner.query(
      'SHOW GRANTS FOR CURRENT_USER'
    );
    const lines = grants.flatMap((row) => Object.values(row));
    if (
      lines.length > 32 ||
      lines.some(
        (value) => typeof value !== 'string' || Buffer.byteLength(value) > 8192
      )
    )
      throw new Error('Fixture privilege inspection exceeds its bound');
    const createGranted = lines.some((line) => {
      const match =
        /^GRANT (.+) ON (\*\.\*|`membership_runtime_drill_v1`\.\*) TO /i.exec(
          line as string
        );
      return (
        !!match &&
        match[1]
          .split(',')
          .some((item) =>
            ['CREATE', 'ALL PRIVILEGES'].includes(item.trim().toUpperCase())
          )
      );
    });
    // A direct grant is evidence, not a simulation of role or organization policy.
    return {
      application_database_distinct: true,
      fixture_visible: schemas.length === 1,
      create_database_grant_observed: createGranted
    };
  });
}

const serverOptions = {
  logger,
  entities: [],
  syncEntities: false,
  skipRedis: true,
  databaseSelection: {
    database: null,
    failOnInitializationError: true as const
  }
};
const fixtureOptions = {
  logger,
  entities: membershipFixtureEntities,
  syncEntities: false,
  skipRedis: true,
  databaseSelection: {
    database: MEMBERSHIP_FIXTURE_DATABASE,
    failOnInitializationError: true as const
  }
};

export async function handleMembershipFixtureAction(
  action: FixtureAction,
  context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  environment: MembershipFixtureEnvironment
): Promise<unknown> {
  const result = await executeFixtureAction(action, context, environment);
  // Durable DB proofs may retain an old claim privately for replay fencing.
  // Every carrier response crosses this boundary, including nested status/setup.
  const encoded = JSON.stringify(result, (key, value: unknown) =>
    key === 'lease_token' ? undefined : value
  );
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 131072)
    throw new Error('Membership fixture response exceeds its bound');
  return JSON.parse(encoded) as unknown;
}

async function executeFixtureAction(
  action: FixtureAction,
  context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  environment: MembershipFixtureEnvironment
) {
  assertMembershipFixtureEnvironment(environment);
  const remaining = context.getRemainingTimeInMillis();
  if (
    !Number.isFinite(remaining) ||
    remaining <
      (action.endsWith('prepare_v1') || action.endsWith('db_proof_v1')
        ? 180000
        : 45000)
  )
    throw new Error('Insufficient membership fixture invocation budget');
  if (action === 'membership_runtime_fixture_preflight_v1') {
    const server = await doInDbContext(inspectServer, serverOptions);
    const schema = server.fixture_visible
      ? await doInDbContext(
          () => preflightMembershipFixtureSchema(getDataSource(), environment),
          fixtureOptions
        )
      : null;
    return { ...server, schema, normal_membership_work: 'unavailable' };
  }
  if (action === 'membership_runtime_fixture_prepare_v1') {
    await doInDbContext(async () => {
      await inspectServer();
      await createMembershipFixtureDatabase(
        getDataSource(),
        environment,
        process.env.DB_NAME!
      );
    }, serverOptions);
    return doInDbContext(async () => {
      const schema = await prepareMembershipFixtureSchema(
        getDataSource(),
        environment
      );
      if (!schema.ready) return { schema, setup: null };
      const setup = await primary(context, async (ctx) => {
        const control = await new MembershipFixtureSetupService(
          sqlExecutor,
          environment
        ).prepare(ctx);
        if (control.state.setup_stage === 'READY') {
          await new MembershipGcCheckpointsDb(() => sqlExecutor).provision(ctx);
          await new MembershipDispatchCheckpointsDb(
            () => sqlExecutor
          ).provision(ctx);
        }
        return control;
      });
      return { schema, setup };
    }, fixtureOptions);
  }
  if (action === 'membership_runtime_fixture_db_proof_v1')
    return doInDbContext(
      () =>
        new MembershipFixtureDbProofService(sqlExecutor, environment).run(
          context
        ),
      fixtureOptions
    );
  return doInDbContext(
    () =>
      primary(context, async (ctx) => {
        const setup = new MembershipFixtureSetupService(
          sqlExecutor,
          environment
        );
        if (action === 'membership_runtime_fixture_status_v1')
          return setup.status(ctx);
        if (action === 'membership_runtime_fixture_advance_v1')
          return setup.advance(ctx);
        if (action === 'membership_runtime_fixture_cleanup_v1')
          return setup.cleanup(ctx);
        throw new Error('Unsupported membership fixture action');
      }),
    fixtureOptions
  );
}
