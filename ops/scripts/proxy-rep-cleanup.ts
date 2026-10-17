/** Explicit operator CLI; never called by deployments, migrations, or application startup. */
import 'reflect-metadata';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DataSource } from 'typeorm';
import {
  BackupSink,
  SqlRunner
} from '../../src/proxy-rep-cleanup/operator-sql';
import {
  executeProxyRepRollback,
  inspectProxyRepRollback,
  ProxyRepRollbackPlan
} from '../../src/proxy-rep-cleanup/proxy-rep-rollback';
import {
  executeShellProfileCleanup,
  inspectShellProfileCleanup,
  parseShellLine,
  shellLine,
  ShellProfileCleanupPlan
} from '../../src/proxy-rep-cleanup/shell-profile-cleanup';

const USAGE = `Usage (CLEANUP_ENVIRONMENT=staging|prod, CLEANUP_DB_HOST/PORT/USER/PASSWORD/DATABASE):
  proxy-rep-cleanup.ts rollback-plan    RUN_DIR PROXY_ID
  proxy-rep-cleanup.ts rollback-execute RUN_DIR ENVIRONMENT:DATABASE:rollback-proxy-rep:PROXY_ID
  proxy-rep-cleanup.ts shells-plan      RUN_DIR
  proxy-rep-cleanup.ts shells-execute   RUN_DIR ENVIRONMENT:DATABASE:cleanup-shell-profiles
Plans are read-only and may use a read replica. Executions need the writer, back up every
deleted or changed row to RUN_DIR/backup, and are safe to re-run after a failure.`;

const SHELL_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}\n${USAGE}`);
  return value;
}

function environment(): 'staging' | 'prod' {
  const value = env('CLEANUP_ENVIRONMENT');
  if (value !== 'staging' && value !== 'prod') {
    throw new Error('CLEANUP_ENVIRONMENT must be staging or prod');
  }
  return value;
}

function writeNew(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Appends each batch as its own gzip member, so a crash never loses an already-written batch. */
function backupSink(dir: string): BackupSink {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    write(table, rows) {
      if (!rows.length) return;
      const lines = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
      appendFileSync(join(dir, `${table}.jsonl.gz`), gzipSync(lines), {
        mode: 0o600
      });
    }
  };
}

function writeBackupManifest(dir: string) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl.gz'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, sha256: sha256File(join(dir, name)) }));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ written_at: new Date().toISOString(), files }, null, 2) +
      '\n',
    { mode: 0o600 }
  );
}

function confirm(given: string | undefined, expected: string) {
  if (given !== expected) {
    throw new Error(`Confirmation must be exactly: ${expected}`);
  }
}

function settings() {
  return {
    batchSize: process.env.CLEANUP_BATCH_SIZE
      ? Number(process.env.CLEANUP_BATCH_SIZE)
      : undefined,
    pauseMs: Number(process.env.CLEANUP_PAUSE_MS ?? 50),
    log: (message: string) =>
      console.log(`${new Date().toISOString()} ${message}`)
  };
}

async function rollbackPlan(runner: SqlRunner, dir: string, proxyId: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { plan, targets } = await inspectProxyRepRollback(runner, proxyId);
  writeNew(join(dir, 'targets.txt'), targets.map((id) => `${id}\n`).join(''));
  writeNew(
    join(dir, 'rollback-plan.json'),
    JSON.stringify({ environment: environment(), ...plan }, null, 2) + '\n'
  );
  console.log(JSON.stringify(plan.counts, null, 2));
  console.log(
    `Categories (${plan.categories.length}): ${plan.categories.join(' | ')}`
  );
  console.log(
    `Skipped categories: ${plan.skipped_categories.join(' | ') || 'none'}`
  );
}

async function rollbackExecute(
  runner: SqlRunner,
  dir: string,
  confirmation: string | undefined
) {
  const plan: ProxyRepRollbackPlan & { environment: string } = JSON.parse(
    readFileSync(join(dir, 'rollback-plan.json'), 'utf8')
  );
  if (plan.environment !== environment()) {
    throw new Error('Plan environment mismatch');
  }
  confirm(
    confirmation,
    `${plan.environment}:${plan.database}:rollback-proxy-rep:${plan.proxy_id}`
  );
  const backupDir = join(dir, 'backup', 'rollback');
  try {
    const result = await executeProxyRepRollback(
      runner,
      plan,
      readLines(join(dir, 'targets.txt')),
      backupSink(backupDir),
      settings()
    );
    writeFileSync(
      join(dir, 'rollback-result.json'),
      JSON.stringify(
        { finished_at: new Date().toISOString(), ...result },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (existsSync(backupDir)) writeBackupManifest(backupDir);
  }
}

async function shellsPlan(runner: SqlRunner, dir: string) {
  if (!existsSync(join(dir, 'rollback-result.json'))) {
    throw new Error(
      'Run rollback-execute to completion before planning shells'
    );
  }
  const { plan, shells } = await inspectShellProfileCleanup(
    runner,
    readLines(join(dir, 'targets.txt')),
    settings()
  );
  writeNew(
    join(dir, 'shells.tsv'),
    shells.map((s) => `${shellLine(s)}\n`).join('')
  );
  writeNew(
    join(dir, 'shells-plan.json'),
    JSON.stringify({ environment: environment(), ...plan }, null, 2) + '\n'
  );
  console.log(
    JSON.stringify(
      { counts: plan.counts, referenced_by: plan.referenced_by },
      null,
      2
    )
  );
}

async function shellsExecute(
  runner: SqlRunner,
  dir: string,
  confirmation: string | undefined
) {
  const plan: ShellProfileCleanupPlan & { environment: string } = JSON.parse(
    readFileSync(join(dir, 'shells-plan.json'), 'utf8')
  );
  if (plan.environment !== environment()) {
    throw new Error('Plan environment mismatch');
  }
  if (Date.now() - plan.planned_at > SHELL_PLAN_MAX_AGE_MS) {
    throw new Error('Shell plan is older than 24 hours; plan again');
  }
  confirm(
    confirmation,
    `${plan.environment}:${plan.database}:cleanup-shell-profiles`
  );
  const backupDir = join(dir, 'backup', 'shells');
  try {
    const result = await executeShellProfileCleanup(
      runner,
      plan,
      readLines(join(dir, 'shells.tsv')).map(parseShellLine),
      backupSink(backupDir),
      settings()
    );
    writeFileSync(
      join(dir, 'shells-result.json'),
      JSON.stringify(
        { finished_at: new Date().toISOString(), ...result },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (existsSync(backupDir)) writeBackupManifest(backupDir);
  }
}

async function main() {
  const [command, dir, argument, ...extra] = process.argv.slice(2);
  if (!command || !dir || extra.length) throw new Error(USAGE);
  environment();
  const source = new DataSource({
    type: 'mysql',
    host: env('CLEANUP_DB_HOST'),
    port: Number(process.env.CLEANUP_DB_PORT ?? 3306),
    username: env('CLEANUP_DB_USER'),
    password: env('CLEANUP_DB_PASSWORD'),
    database: env('CLEANUP_DB_DATABASE'),
    charset: 'utf8mb4',
    timezone: 'Z',
    entities: [],
    synchronize: false,
    migrationsRun: false,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  await source.initialize();
  const runner = source.createQueryRunner('master');
  try {
    await runner.query("SET SESSION time_zone = '+00:00'");
    if (command === 'rollback-plan' && argument) {
      await rollbackPlan(runner, dir, argument);
    } else if (command === 'rollback-execute') {
      await rollbackExecute(runner, dir, argument);
    } else if (command === 'shells-plan' && !argument) {
      await shellsPlan(runner, dir);
    } else if (command === 'shells-execute') {
      await shellsExecute(runner, dir, argument);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    await runner.release();
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  // Print diagnostics without serializing driver objects (which can contain credentials).
  let diagnostic =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  for (const key of ['HOST', 'USER', 'PASSWORD']) {
    const value = process.env[`CLEANUP_DB_${key}`];
    if (value) diagnostic = diagnostic.split(value).join('[redacted]');
  }
  console.error(diagnostic);
  console.error(
    'Cleanup stopped. Completed batches are committed and backed up; re-run the same command to continue.'
  );
  process.exitCode = 1;
});
