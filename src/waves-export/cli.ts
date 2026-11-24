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

async function runExport(command: WavesExportCommand) {
  // Dates read from MySQL in UTC, whatever the host.
  process.env.TZ = 'UTC';
  // Stays null for a rehearsal, which checks neither the time nor the lag.
  let earliestMs: number | null = null;
  if (command.freezeMs !== null) {
    earliestMs = command.freezeMs + EXPORT_AFTER_FREEZE_MS;
    if (Date.now() < earliestMs) {
      throw new WavesExportUsageError(
        `The waves freeze is at ${new Date(command.freezeMs).toISOString()}. ` +
          `The export starts from ${new Date(earliestMs).toISOString()}, ` +
          `five minutes after it: run it again then.`,
        { showHelp: false }
      );
    }
  }
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
    const log = (message: string) =>
      process.stderr.write(
        `[waves-export] ${new Date().toISOString()} ${message}\n`
      );
    return await doInDbContext(
      async () => {
        // Before any stage reads, through the DB layer the reads go through.
        const { sqlExecutor } = await import('@/sql-executor');
        const replicaLag = await replicaLagAtStart({
          caughtUpMs: earliestMs,
          checkedByPerson: command.replicaLagChecked,
          readRows: (sql) => sqlExecutor.execute(sql),
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
          resumeDrops: command.resume,
          replicaLag,
          log
        }).run();
      },
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
