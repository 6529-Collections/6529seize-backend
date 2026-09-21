/** Explicit operator CLI; never called by deployments, migrations, or application startup. */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import {
  dropRetiredSchema,
  inspectRetiredSchema,
  RetirementInventory,
  sha256
} from '../../src/dbMigrationsLoop/retired-schema-cleanup';

interface Plan {
  environment: 'staging' | 'prod';
  inventory: RetirementInventory;
  backup?: {
    path: string;
    sha256: string;
    restoreEvidencePath: string;
    restoreEvidenceSha256: string;
  };
  prerequisites?: {
    applicationHealthy: true;
    allDeployedConsumersAudited: true;
    dispatcherDeleted: true;
    workerDeleted: true;
    deliveriesSettled: true;
  };
}

function commandOptions() {
  const [mode, planPath, confirmation, ...extra] = process.argv.slice(2);
  if (
    !['plan', 'execute'].includes(mode) ||
    !planPath ||
    extra.length ||
    (mode === 'plan' && confirmation)
  ) {
    throw new Error(
      'Usage: retire-membership-schema.ts plan|execute PLAN_JSON [ENVIRONMENT:DATABASE:retire-membership]'
    );
  }
  const environment = process.env.RETIRE_ENVIRONMENT;
  if (environment !== 'staging' && environment !== 'prod') {
    throw new Error(
      'Select the separately authorized retirement environment explicitly'
    );
  }
  for (const key of ['HOST', 'PORT', 'USER', 'PASSWORD', 'DATABASE']) {
    if (!process.env[`RETIRE_DB_${key}`])
      throw new Error(`Missing RETIRE_DB_${key}`);
  }
  return { mode, planPath, confirmation, environment };
}

function verifyRecovery(plan: Plan) {
  const backup = plan.backup;
  if (!backup) throw new Error('A verified backup is required');
  const restoreBytes = readFileSync(backup.restoreEvidencePath);
  if (
    sha256(readFileSync(backup.path)) !== backup.sha256 ||
    sha256(restoreBytes) !== backup.restoreEvidenceSha256
  ) {
    throw new Error('Backup or restore evidence digest mismatch');
  }
  const restored = JSON.parse(restoreBytes.toString('utf8')) as {
    verified?: boolean;
    backupSha256?: string;
    tables?: RetirementInventory['tables'];
  };
  if (
    restored.verified !== true ||
    restored.backupSha256 !== backup.sha256 ||
    JSON.stringify(restored.tables) !== JSON.stringify(plan.inventory.tables)
  ) {
    throw new Error(
      'Restore evidence must verify the exact backup and every approved table'
    );
  }
}

function approvedPlan(
  options: ReturnType<typeof commandOptions>
): Plan | undefined {
  if (options.mode !== 'execute') return undefined;
  const plan: Plan = JSON.parse(readFileSync(options.planPath, 'utf8'));
  if (
    plan.environment !== options.environment ||
    options.confirmation !==
      `${options.environment}:${plan.inventory.database}:retire-membership` ||
    process.env.RETIRE_DB_DATABASE !== plan.inventory.database
  ) {
    throw new Error('Plan environment/database confirmation does not match');
  }
  const required = [
    'applicationHealthy',
    'allDeployedConsumersAudited',
    'dispatcherDeleted',
    'workerDeleted',
    'deliveriesSettled'
  ] as const;
  if (
    !plan.prerequisites ||
    required.some((key) => plan.prerequisites?.[key] !== true)
  ) {
    throw new Error(
      'Operational prerequisites must be recorded before retirement'
    );
  }
  verifyRecovery(plan);
  return plan;
}

async function main() {
  const options = commandOptions();
  const plan = approvedPlan(options);
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
    bigNumberStrings: true
  });
  await source.initialize();
  const runner = source.createQueryRunner('master');
  try {
    if (plan) {
      await dropRetiredSchema(runner, plan.inventory);
      console.log(
        'Verified removal of the approved retired membership tables.'
      );
    } else {
      const inventory = await inspectRetiredSchema(runner);
      writeFileSync(
        options.planPath,
        JSON.stringify(
          { environment: options.environment, inventory },
          null,
          2
        ) + '\n',
        { mode: 0o600, flag: 'wx' }
      );
      console.log(
        'Read-only plan saved. Record and verify backup, restore evidence, and prerequisites before execution.'
      );
    }
  } finally {
    await runner.release();
    await source.destroy();
  }
}

main().catch(() => {
  console.error(
    'Retirement failed; inspect the database and reconcile the plan before retrying. No automatic retry.'
  );
  process.exitCode = 1;
});
