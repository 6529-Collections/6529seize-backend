/** Temporary, IAM-only operator packaging target. It is never a deployable
 * application service and must be deleted after the authorized operation. */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager';
import {
  cleanupDigest,
  deleteCompetitionOrphans,
  dropCompetitionStorage,
  inspectCompetitionOrphans,
  inspectCompetitionStorage,
  prepareCompetitionStorage
} from '../../../src/competitions/competition-storage-cleanup';
import {
  assertCompetitionCleanupRecovery,
  type CompetitionCleanupPlan,
  type CompetitionCleanupRecovery
} from './approval';

type Operation = 'plan' | 'orphans' | 'prepare' | 'drop';
function options(context: { invokedFunctionArn: string }) {
  const environment = process.env.RETIRE_ENVIRONMENT;
  const operation = process.env.RETIRE_OPERATION;
  if (
    (environment !== 'staging' && environment !== 'prod') ||
    !['plan', 'orphans', 'prepare', 'drop'].includes(operation ?? '')
  )
    throw new Error('Explicit cleanup environment and operation are required');
  const region = environment === 'prod' ? 'us-east-1' : 'eu-west-1';
  if (
    !context.invokedFunctionArn.startsWith(
      `arn:aws:lambda:${region}:987989283142:function:codexCompetitionStorageCleanup`
    )
  )
    throw new Error(
      'Unexpected temporary cleanup function account, region or identity'
    );
  const override = process.env.RETIRE_RESTORE_HOST;
  if (
    override &&
    (operation !== 'plan' ||
      !/^competition-retirement-(staging|prod)-restore-[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(
        override
      ))
  )
    throw new Error(
      'Snapshot restore connections are read-only and require the named isolated recovery target'
    );
  return {
    environment,
    operation: operation as Operation,
    region,
    override
  } as const;
}

function approval(
  operation: Operation,
  environment: CompetitionCleanupPlan['environment'],
  event: unknown
) {
  if (operation === 'plan') return null;
  const plan = JSON.parse(
    readFileSync('/var/task/approved-plan.json', 'utf8')
  ) as CompetitionCleanupPlan;
  const recovery = JSON.parse(
    readFileSync('/var/task/recovery.json', 'utf8')
  ) as CompetitionCleanupRecovery;
  const expected = `${environment}:${plan.inventory.database}:${cleanupDigest(plan)}:${operation}`;
  if (
    plan.environment !== environment ||
    !event ||
    typeof event !== 'object' ||
    (event as { confirmation?: unknown }).confirmation !== expected
  )
    throw new Error(
      'Environment, database and reviewed-plan confirmation do not match'
    );
  assertCompetitionCleanupRecovery(plan, recovery);
  return plan;
}

export const handler = async (
  event: unknown,
  context: { invokedFunctionArn: string; awsRequestId?: string }
) => {
  let source: DataSource | undefined;
  try {
    const selected = options(context);
    const plan = approval(selected.operation, selected.environment, event);
    const response = await new SecretsManagerClient({
      region: selected.region
    }).send(new GetSecretValueCommand({ SecretId: 'prod/lambdas' }));
    const secret = JSON.parse(response.SecretString ?? '{}') as Record<
      string,
      string
    >;
    const readOnly = selected.operation === 'plan';
    for (const key of [
      'DB_HOST',
      'DB_PORT',
      'DB_NAME',
      readOnly ? 'DB_USER_READ' : 'DB_USER',
      readOnly ? 'DB_PASS_READ' : 'DB_PASS'
    ])
      if (!secret[key])
        throw new Error('Incomplete cleanup database configuration');
    source = new DataSource({
      type: 'mysql',
      host: selected.override ?? secret.DB_HOST,
      port: Number(secret.DB_PORT),
      username: secret[readOnly ? 'DB_USER_READ' : 'DB_USER'],
      password: secret[readOnly ? 'DB_PASS_READ' : 'DB_PASS'],
      database: secret.DB_NAME,
      entities: [],
      synchronize: false,
      migrationsRun: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      extra: { dateStrings: true }
    });
    await source.initialize();
    const runner = source.createQueryRunner('master');
    try {
      await runner.query('set session lock_wait_timeout=5');
      await runner.query('set session innodb_lock_wait_timeout=5');
      await runner.query('set session max_execution_time=10000');
      if (!plan) {
        const result: CompetitionCleanupPlan = {
          environment: selected.environment,
          inventory: await inspectCompetitionStorage(runner),
          orphans: await inspectCompetitionOrphans(runner)
        };
        return {
          ok: true,
          requestId: context.awsRequestId,
          plan: result,
          digest: cleanupDigest(result)
        };
      }
      const [identity]: { database: string; serverUuid: string }[] =
        await runner.query(
          'select database() as `database`,@@server_uuid as serverUuid'
        );
      if (
        identity.database !== plan.inventory.database ||
        identity.serverUuid !== plan.inventory.serverUuid
      )
        throw new Error(
          'Connected writer identity differs from the approved source'
        );
      let result: unknown;
      if (selected.operation === 'orphans')
        result = await deleteCompetitionOrphans(runner, plan.orphans);
      else if (selected.operation === 'prepare') {
        await prepareCompetitionStorage(runner);
        result = { prepared: true };
      } else result = await dropCompetitionStorage(runner, plan.inventory);
      return {
        ok: true,
        requestId: context.awsRequestId,
        operation: selected.operation,
        planDigest: cleanupDigest(plan),
        result
      };
    } finally {
      await runner.release();
    }
  } catch (error) {
    // Do not log driver objects, SQL parameters, credentials or source records.
    return {
      ok: false,
      requestId: context.awsRequestId,
      message:
        error instanceof Error
          ? error.message.split('\n')[0]
          : 'Cleanup failed; inspect private operational evidence'
    };
  } finally {
    if (source?.isInitialized) await source.destroy();
  }
};
