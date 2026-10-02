import * as Joi from 'joi';
import {
  CompetitionMigrationService,
  MigrationOperator
} from './competition-migration.service';

export type MigrationCliOptions = {
  readonly environment: 'local' | 'staging' | 'production';
  readonly competition: string;
  readonly action:
    | 'status'
    | 'enroll'
    | 'backfill'
    | 'catch-up'
    | 'compare'
    | 'readiness'
    | 'cutover'
    | 'rollback'
    | 'reverse-reconcile'
    | 'retry-effects'
    | 'record-acceptance'
    | 'record-exception'
    | 'verify'
    | 'review-repair';
  readonly evidence?: string;
  readonly exception?: string;
  readonly acceptance?: string;
  readonly operator?: string;
  readonly reason?: string;
  readonly cohort?:
    | 'COMPLETED_INTERNAL'
    | 'COMPLETED_ORDINARY'
    | 'ACTIVE_LOW_VOLUME'
    | 'COMPLEX'
    | 'PRIVILEGED';
  readonly batch: number;
  readonly window: number;
  readonly live: boolean;
};
function parseMigrationArguments(
  args: readonly string[]
): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live') {
      if (parsed.live) throw new Error('Duplicate --live');
      parsed.live = true;
    } else if (
      arg.startsWith('--') &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      const key = arg.slice(2);
      if (key in parsed) throw new Error(`Duplicate option: ${arg}`);
      parsed[key] = args[++index];
    } else throw new Error('Invalid arguments; use --help');
  }
  return parsed;
}

export function parseMigrationOptions(
  args: readonly string[]
): MigrationCliOptions {
  const parsed = parseMigrationArguments(args);
  const result = Joi.object<MigrationCliOptions>({
    environment: Joi.string()
      .valid('local', 'staging', 'production')
      .required(),
    competition: Joi.string().uuid().required(),
    action: Joi.string()
      .valid(
        'status',
        'enroll',
        'backfill',
        'catch-up',
        'compare',
        'readiness',
        'cutover',
        'rollback',
        'reverse-reconcile',
        'retry-effects',
        'record-acceptance',
        'record-exception',
        'verify',
        'review-repair'
      )
      .default('status'),
    evidence: Joi.string()
      .uri({ scheme: ['https'] })
      .max(2000),
    exception: Joi.string().pattern(/^[A-Z][A-Z_]{2,80}$/),
    acceptance: Joi.string().min(1).max(2000),
    operator: Joi.string().min(1).max(100),
    reason: Joi.string().min(1).max(2000),
    cohort: Joi.string().valid(
      'COMPLETED_INTERNAL',
      'COMPLETED_ORDINARY',
      'ACTIVE_LOW_VOLUME',
      'COMPLEX',
      'PRIVILEGED'
    ),
    batch: Joi.number().integer().min(1).max(100).default(100),
    window: Joi.number().integer().min(1).max(86400000).default(60000),
    live: Joi.boolean().default(false)
  })
    .unknown(false)
    .validate(parsed);
  if (result.error) throw new Error(result.error.message);
  if (result.value.live && (!result.value.operator || !result.value.reason))
    throw new Error('Live operations require --operator and --reason');
  if (result.value.action === 'enroll' && !result.value.cohort)
    throw new Error('Enrollment requires an explicit --cohort');
  return result.value;
}

async function dispatchMigrationCommand(
  options: MigrationCliOptions,
  service = new CompetitionMigrationService()
): Promise<unknown> {
  const operator: MigrationOperator = {
    actor: options.operator ?? 'dry-run',
    reason: options.reason ?? 'read-only inspection'
  };
  if (options.action === 'verify')
    return service.verifyNative(options.competition);
  if (options.action === 'status') return service.status(options.competition);
  if (options.action === 'readiness')
    return service.readiness(options.competition);
  if (options.action === 'cutover')
    return service.cutover(options.competition, operator, !options.live);
  if (options.action === 'rollback')
    return service.rollback(options.competition, operator, !options.live);
  if (!options.live)
    return {
      dryRun: true,
      action: options.action,
      environment: options.environment,
      competitionId: options.competition,
      status: await service.status(options.competition)
    };
  switch (options.action) {
    case 'enroll':
      return service.enroll(options.competition, operator, options.cohort!);
    case 'backfill':
      return service.backfill(options.competition, operator, options.batch);
    case 'catch-up':
      return service.catchUp(options.competition, operator, options.batch);
    case 'review-repair': {
      if (!options.evidence)
        throw new Error(
          'Use --evidence with the reviewed native repair record'
        );
      return service.reviewRepair(
        options.competition,
        operator,
        options.evidence
      );
    }
    case 'record-exception': {
      if (!options.exception) throw new Error('Use --exception <stable-code>');
      return service.recordException(
        options.competition,
        operator,
        options.exception
      );
    }
    case 'record-acceptance': {
      if (!options.acceptance)
        throw new Error('Use --acceptance with a reviewed JSON file');
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(options.acceptance, 'utf8');
      if (raw.length > 32000)
        throw new Error('Acceptance file exceeds operator record limit');
      return service.recordAcceptance(
        options.competition,
        operator,
        JSON.parse(raw)
      );
    }
    case 'reverse-reconcile':
      return service.reverseReconcile(
        options.competition,
        operator,
        options.batch
      );
    case 'retry-effects': {
      await service.status(options.competition);
      const { retryLegacyExecutionEffects } =
        await import('./legacy-competition-execution-effects');
      await retryLegacyExecutionEffects(options.competition);
      return service.status(options.competition);
    }
    case 'compare':
      return service.compare(options.competition, operator, options.window);
  }
}

export async function executeMigrationCommand(
  options: MigrationCliOptions,
  service = new CompetitionMigrationService()
): Promise<unknown> {
  try {
    return await dispatchMigrationCommand(options, service);
  } catch (error) {
    if (
      options.live &&
      error instanceof Error &&
      error.message.startsWith('OWNED_EXCEPTION:')
    ) {
      const status = await service.status(options.competition);
      if (status.migration && status.storageMode === 'LEGACY_ADAPTER') {
        await service.recordException(
          options.competition,
          {
            actor: options.operator!,
            reason: options.reason!
          },
          'MIGRATION_DATA_SHAPE'
        );
      }
    }
    throw error;
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(
      'competition:migrate --environment local|staging|production --competition <stable-legacy-uuid> --action status|enroll|backfill|catch-up|compare|readiness|cutover|reverse-reconcile|rollback|retry-effects|record-acceptance|record-exception|verify|review-repair [--acceptance <reviewed-json>] [--exception <stable-code>] [--evidence <https-url>] [--cohort <cohort>] [--batch 1..100] [--window <milliseconds>] [--operator <profile-id> --reason <text> --live]\nOne competition only. Default is read-only. Requires explicitly configured DB environment and an allowlisted operator for live commands.\n'
    );
    return;
  }
  const options = parseMigrationOptions(args);
  if (process.env.COMPETITION_MIGRATION_ENVIRONMENT !== options.environment)
    throw new Error(
      'COMPETITION_MIGRATION_ENVIRONMENT must match the explicit target environment'
    );
  if (
    options.live &&
    !(process.env.COMPETITION_MIGRATION_OPERATORS ?? '')
      .split(',')
      .map((value) => value.trim())
      .includes(options.operator!)
  )
    throw new Error('Operator is not allowlisted for this environment');
  // The CLI never fetches production secrets. A later authorized operator must
  // supply its reviewed environment; schema synchronization is not a CLI action.
  if (process.env.NODE_ENV !== 'local')
    throw new Error(
      'Use NODE_ENV=local with explicitly supplied DB configuration; this CLI never loads cloud secrets'
    );
  if (
    options.environment === 'local' &&
    !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST ?? '')
  )
    throw new Error('Local rehearsal requires a loopback disposable database');
  const { doInDbContext } = await import('@/secrets');
  const result = await doInDbContext(() => executeMigrationCommand(options), {
    syncEntities: false,
    skipRedis: true
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
function migrationStopCode(message: string): string {
  if (message.startsWith('OWNED_EXCEPTION:')) return 'OWNED_EXCEPTION';
  if (message.includes('journal gap')) return 'CAPTURE_JOURNAL_GAP';
  if (message.includes('allowlisted')) return 'OPERATOR_NOT_ALLOWLISTED';
  return 'COMMAND_FAILED';
}

if (require.main === module)
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const stop = migrationStopCode(message);
    process.stderr.write(
      `${stop}: migration command stopped. Run status/readiness for the same explicit UUID; no ownership change should be assumed.\n`
    );
    process.exitCode = 1;
  });
