import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseWaveIds,
  parseWavesExportCommand,
  WAVES_EXPORT_HELP,
  WavesExportCommand,
  WavesExportUsageError
} from './cli-options';

/**
 * How long after the freeze the export may start. A write 6529.io admitted
 * just before the freeze, by a request or by a background job that checked
 * the freeze once, can still commit after it, once its lock waits end
 * (MySQL's innodb_lock_wait_timeout, 50 s per wait by default). Five minutes
 * covers that with room to spare. The read replica's lag comes on top: the
 * export then checks that every reader has caught up past this time
 * (waves-export.replica-lag.ts).
 */
export const EXPORT_AFTER_FREEZE_MS = 5 * 60 * 1000;

/**
 * Refuses an export before five minutes after the freeze, naming when it
 * may start. Returns that time; null for a rehearsal (freezeMs null), which
 * has no time check.
 */
export function refuseBeforeExportStart(
  freezeMs: number | null,
  nowMs: number
): number | null {
  if (freezeMs === null) return null;
  const earliestMs = freezeMs + EXPORT_AFTER_FREEZE_MS;
  if (nowMs < earliestMs) {
    throw new WavesExportUsageError(
      `The waves freeze is at ${new Date(freezeMs).toISOString()}. ` +
        `The export starts from ${new Date(earliestMs).toISOString()}, ` +
        `five minutes after it: run it again then.`,
      { showHelp: false }
    );
  }
  return earliestMs;
}

/**
 * The signed records wave's id, which stays on 6529.io: --records-wave-id,
 * else SIGNED_RECORDS_WAVE_ID as the run's environment has it. Refuses when
 * neither names it, so it can't move by a missing setting, and when both
 * name different waves.
 */
export function recordsWaveIdFor(
  option: string | null,
  env: Readonly<Record<string, string | undefined>>
): string {
  const fromEnv = env.SIGNED_RECORDS_WAVE_ID?.trim() || null;
  if (option && fromEnv && option !== fromEnv) {
    throw new WavesExportUsageError(
      `--records-wave-id ${option} and SIGNED_RECORDS_WAVE_ID ${fromEnv} name different waves: give one, or make them agree.`,
      { showHelp: false }
    );
  }
  const id = option ?? fromEnv;
  if (!id) {
    throw new WavesExportUsageError(
      'The export needs the signed records wave, which stays on 6529.io: give ' +
        '--records-wave-id <its id>, or set SIGNED_RECORDS_WAVE_ID. Without it ' +
        'the records wave would move with the rest.',
      { showHelp: false }
    );
  }
  return id;
}

/** What a caller other than the command line adds to a run. */
export interface WavesExportRunHooks {
  /** WavesExportOptions.stopBeforeWave: a job's time limit. */
  readonly stopBeforeWave?: () => boolean;
}

/**
 * One run of the export, as the command line runs it: the time check, the
 * replica checks and the stages, through the shared DB layer. The
 * dbDumpsDaily waves export job runs it too.
 */
export async function runExport(
  command: WavesExportCommand,
  hooks: WavesExportRunHooks = {}
) {
  // Dates read from MySQL in UTC, whatever the host.
  process.env.TZ = 'UTC';
  // Stays null for a rehearsal: no time check, and the lag only reported.
  const earliestMs = refuseBeforeExportStart(command.freezeMs, Date.now());
  const waveIds = command.wavesFile
    ? parseWaveIds(fs.readFileSync(command.wavesFile, 'utf8'))
    : command.waveIds;
  // The shared environment and DB startup log to stdout: keep stdout for the
  // one JSON summary.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const { doInDbContext } = await import('@/secrets');
    const { BackendWavesExportSource } =
      await import('./waves-export.backend-source');
    const { WavesExport } = await import('./waves-export.service');
    const { RawDirectory } = await import('./waves-export.writer');
    const { replicaLagAtStart } = await import('./waves-export.replica-lag');
    const { withApiSqlExecutor } = await import('./waves-export.db');
    const log = (message: string) =>
      process.stderr.write(
        `[waves-export] ${new Date().toISOString()} ${message}\n`
      );
    return await doInDbContext(
      // Every read through the API's own SQL executor: the legacy GET view
      // and the API's number types, as the public API reads.
      () =>
        withApiSqlExecutor(async () => {
          // Before any stage reads, through the DB layer the reads go through:
          // its write-side pool, on DB_HOST (DB_IAM_HOST in IAM mode). The
          // check's queries share one connection, in a transaction that only
          // reads, so they read one server.
          const { sqlExecutor } = await import('@/sql-executor');
          const { resolveDbConnectionTargets } = await import('@/db-iam-auth');
          // The environment is loaded by now (the shared secret in a job).
          const recordsWaveId = recordsWaveIdFor(
            command.recordsWaveId,
            process.env
          );
          const replicaLag = await replicaLagAtStart({
            caughtUpMs: earliestMs,
            checkedByPerson: command.replicaLagCheckedBy,
            onOneConnection: (work) =>
              sqlExecutor.executeNativeQueriesInTransaction((connection) =>
                work((sql) =>
                  sqlExecutor.execute(sql, undefined, {
                    wrappedConnection: connection
                  })
                )
              ),
            hostSetting: resolveDbConnectionTargets().write.iam
              ? 'DB_IAM_HOST'
              : 'DB_HOST',
            log
          });
          return new WavesExport(new BackendWavesExportSource(), {
            raw: new RawDirectory(path.join(command.out, 'raw')),
            stages: command.stages,
            freezeMs: command.freezeMs,
            exporterRevision: command.revision,
            waveIds,
            dropPageSize: command.pageSize,
            concurrency: command.concurrency,
            bothMetric: command.bothMetric,
            recordsWaveId,
            resumeDrops: command.resume,
            stopBeforeWave: hooks.stopBeforeWave,
            replicaLag,
            log
          }).run();
        }),
      { syncEntities: false, skipRedis: true }
    );
  } finally {
    process.stdout.write = stdoutWrite;
  }
}

export async function main(
  args: string[] = process.argv.slice(2)
): Promise<void> {
  const command = parseWavesExportCommand(args);
  if (command.command === 'help') {
    process.stdout.write(WAVES_EXPORT_HELP);
    return;
  }
  const summary = await runExport(command);
  process.stdout.write(
    `${JSON.stringify({ out: command.out, ...summary }, null, 2)}\n`
  );
  if (summary.failed_waves.length && !command.allowFailedWaves) {
    process.stderr.write(
      `${summary.failed_waves.length} waves could not be read and are left out (export.json lists them). Fix them and run --stages waves again, or accept them with --allow-failed-waves.\n`
    );
    process.exitCode = 3;
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof WavesExportUsageError) {
      process.stderr.write(
        error.showHelp
          ? `${error.message}\n\n${WAVES_EXPORT_HELP}`
          : `${error.message}\n`
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
