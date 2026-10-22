/** Explicit local operator. Credentials remain in the process environment. */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import {
  cleanupDigest,
  inspectCompetitionStorage,
  inspectCompetitionOrphans,
  deleteCompetitionOrphans,
  prepareCompetitionStorage,
  dropCompetitionStorage
} from '../../../src/competitions/competition-storage-cleanup';
import {
  assertCompetitionCleanupRecovery,
  type CompetitionCleanupPlan,
  type CompetitionCleanupRecovery
} from './approval';

async function main() {
  const [mode, planPath, recoveryPath, confirmation, ...extra] =
    process.argv.slice(2);
  const environment = process.env.RETIRE_ENVIRONMENT;
  if (
    !['plan', 'orphans', 'prepare', 'drop'].includes(mode) ||
    !planPath ||
    extra.length ||
    (environment !== 'staging' && environment !== 'prod')
  )
    throw new Error(
      'Select RETIRE_ENVIRONMENT and plan|orphans|prepare|drop PLAN [RECOVERY ENVIRONMENT:DATABASE:PLAN_DIGEST:MODE]'
    );
  const plan: CompetitionCleanupPlan | null =
    mode === 'plan' ? null : JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan) {
    if (
      !recoveryPath ||
      plan.environment !== environment ||
      confirmation !==
        `${environment}:${plan.inventory.database}:${cleanupDigest(plan)}:${mode}`
    )
      throw new Error(
        'Plan environment/database/digest confirmation does not match'
      );
    assertCompetitionCleanupRecovery(
      plan,
      JSON.parse(
        readFileSync(recoveryPath, 'utf8')
      ) as CompetitionCleanupRecovery
    );
  } else if (recoveryPath || confirmation)
    throw new Error('Read-only planning accepts only a new output path');
  for (const key of ['HOST', 'PORT', 'USER', 'PASSWORD', 'DATABASE'])
    if (!process.env[`RETIRE_DB_${key}`])
      throw new Error(`Missing RETIRE_DB_${key}`);
  if (plan && process.env.RETIRE_DB_DATABASE !== plan.inventory.database)
    throw new Error('Configured database does not match the approved plan');
  const source = new DataSource({
    type: 'mysql',
    host: process.env.RETIRE_DB_HOST,
    port: Number(process.env.RETIRE_DB_PORT),
    username: process.env.RETIRE_DB_USER,
    password: process.env.RETIRE_DB_PASSWORD,
    database: process.env.RETIRE_DB_DATABASE,
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
      await runner.startTransaction();
      try {
        const result: CompetitionCleanupPlan = {
          environment,
          inventory: await inspectCompetitionStorage(runner),
          orphans: await inspectCompetitionOrphans(runner)
        };
        await runner.commitTransaction();
        writeFileSync(planPath, JSON.stringify(result, null, 2) + '\n', {
          mode: 0o600,
          flag: 'wx'
        });
        console.log(
          'Saved private read-only cleanup inventory. An independently verified snapshot restore is required before mutation.'
        );
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    } else {
      const [identity]: { database: string; serverUuid: string }[] =
        await runner.query(
          'select database() as `database`,@@server_uuid as serverUuid'
        );
      if (
        identity.database !== plan.inventory.database ||
        identity.serverUuid !== plan.inventory.serverUuid
      )
        throw new Error('Connected database identity changed');
      if (mode === 'orphans')
        console.log(
          JSON.stringify(await deleteCompetitionOrphans(runner, plan.orphans))
        );
      else if (mode === 'prepare') await prepareCompetitionStorage(runner);
      else
        console.log(
          JSON.stringify(await dropCompetitionStorage(runner, plan.inventory))
        );
    }
  } finally {
    await runner.release();
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  let message =
    error instanceof Error ? error.message : 'Unknown operator failure';
  for (const key of ['HOST', 'USER', 'PASSWORD']) {
    const value = process.env[`RETIRE_DB_${key}`];
    if (value) message = message.split(value).join('[redacted]');
  }
  console.error(message);
  console.error(
    'No automatic retry. Inspect and reconcile any partial DDL before continuing.'
  );
  process.exitCode = 1;
});
