import * as Joi from 'joi';
import { CompetitionMigrationService } from './competition-migration.service';
import { migrateWave, WaveMigrationOptions } from './wave-migration';
import { MigrationEnvironment } from './competition-migration-policy';
import { legacyCompetitionId } from './competition-id';

type CliOptions = WaveMigrationOptions & { live: boolean };

function parseArguments(args: readonly string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = { waveId: args[0] };
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    const key = option.slice(2);
    if (!option.startsWith('--') || key in parsed)
      throw new Error('Invalid or duplicate option; use --help');
    if (key === 'live' || key === 'dry-run') parsed[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${option}`);
      parsed[key] = value;
    }
  }
  return parsed;
}

export function parseWaveMigrationOptions(
  args: readonly string[],
  config: NodeJS.ProcessEnv = process.env
): CliOptions {
  const result = Joi.object({
    waveId: Joi.string().uuid().required(),
    environment: Joi.string()
      .valid('local', 'staging', 'production')
      .default(config.COMPETITION_MIGRATION_ENVIRONMENT ?? 'local'),
    operator: Joi.string().min(1).max(100),
    reason: Joi.string().min(1).max(2000),
    batch: Joi.number().integer().min(1).max(100).default(25),
    'timeout-minutes': Joi.number().integer().min(1).max(1440).default(60),
    live: Joi.boolean().default(false),
    'dry-run': Joi.boolean().default(false)
  })
    .unknown(false)
    .validate(parseArguments(args));
  if (result.error) throw new Error(result.error.message);
  const value = result.value;
  if (value.live && value['dry-run'])
    throw new Error('Choose --live or --dry-run');
  const environment: MigrationEnvironment = value.environment;
  const defaultActor = environment === 'local' ? 'local-operator' : undefined;
  const inspectionActor = value.live ? undefined : 'dry-run';
  const actor =
    value.operator ??
    config.COMPETITION_MIGRATION_OPERATOR ??
    defaultActor ??
    inspectionActor;
  if (!actor)
    throw new Error(
      'Configure COMPETITION_MIGRATION_OPERATOR for this environment'
    );
  return {
    waveId: value.waveId,
    environment,
    operator: {
      actor,
      reason: value.reason ?? `Single-wave migration ${value.waveId}`
    },
    batch: value.batch,
    timeoutMs: value['timeout-minutes'] * 60000,
    dryRun: value['dry-run'] || (environment !== 'local' && !value.live),
    live: value.live
  };
}

export function assertWaveMigrationEnvironment(
  options: CliOptions,
  config: NodeJS.ProcessEnv
): void {
  if (config.NODE_ENV !== 'local')
    throw new Error(
      'Use NODE_ENV=local with explicitly supplied DB configuration; cloud secrets are never loaded'
    );
  if (
    (config.COMPETITION_MIGRATION_ENVIRONMENT ?? 'local') !==
    options.environment
  )
    throw new Error(
      'COMPETITION_MIGRATION_ENVIRONMENT must match the target environment'
    );
  if (options.environment === 'local') {
    if (
      !['localhost', '127.0.0.1', '::1'].includes(config.DB_HOST ?? '') ||
      !['localhost', '127.0.0.1', '::1'].includes(config.DB_HOST_READ ?? '')
    )
      throw new Error('Local migration requires loopback read/write databases');
  } else if (
    !options.dryRun &&
    !(config.COMPETITION_MIGRATION_OPERATORS ?? '')
      .split(',')
      .map((actor) => actor.trim())
      .includes(options.operator.actor)
  )
    throw new Error('Operator is not allowlisted for this environment');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'migrate-wave <wave-uuid> [--dry-run] [--environment local|staging|production] [--live] [--operator <profile-id>] [--reason <text>] [--batch 1..100] [--timeout-minutes 1..1440]\n' +
        'Local: loads .env.local, prepares additive migration schema and runs/resumes migration.\n' +
        'Staging/production: requires an explicit environment, deployed compatible services and a recorded environment acceptance; defaults to inspection until --live.\n'
    );
    return;
  }
  process.env.NODE_ENV ??= 'local';
  const { loadLocalConfig } = await import('@/env');
  await loadLocalConfig();
  const options = parseWaveMigrationOptions(args);
  assertWaveMigrationEnvironment(options, process.env);
  const { doInDbContext } = await import('@/secrets');
  let aborted = false;
  const interrupt = () => {
    aborted = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await doInDbContext(
      async () => {
        const progress = (message: string) =>
          process.stdout.write(`${message}\n`);
        if (options.environment === 'local' && !options.dryRun) {
          progress(
            'Preparing additive local migration schema, compatibility views and capture.'
          );
          const { prepareLocalMigration } =
            await import('./competition-migration-local');
          await prepareLocalMigration(options.waveId);
        }
        const service = new CompetitionMigrationService(
          undefined,
          undefined,
          undefined,
          options.environment
        );
        try {
          const result = await migrateWave(options, service, {
            now: Date.now,
            wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            progress,
            aborted: () => aborted
          });
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith('OWNED_EXCEPTION:') &&
            !options.dryRun
          ) {
            const id = legacyCompetitionId(options.waveId);
            const status = await service.status(id);
            if (status.migration)
              await service.recordException(
                id,
                options.operator,
                status.storageMode === 'NATIVE'
                  ? 'NATIVE_MIGRATION_DATA_SHAPE'
                  : 'MIGRATION_DATA_SHAPE'
              );
          }
          throw error;
        }
      },
      { syncEntities: false, skipRedis: true }
    );
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Migration stopped: ${error instanceof Error ? error.message : 'unknown failure'}\n`
    );
    process.exitCode = 1;
  });
