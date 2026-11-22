import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseWaveIds,
  parseWavesExportCommand,
  WAVES_EXPORT_HELP,
  WavesExportCommand,
  WavesExportUsageError
} from './cli-options';

async function runExport(command: WavesExportCommand) {
  // Dates read from MySQL in UTC, whatever the host.
  process.env.TZ = 'UTC';
  if (command.freezeMs !== null && Date.now() < command.freezeMs) {
    throw new WavesExportUsageError(
      `The waves freeze is at ${new Date(command.freezeMs).toISOString()}: export after it (or --rehearsal)`
    );
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
    return await doInDbContext(
      () =>
        new WavesExport(new BackendWavesExportSource(), {
          raw: new RawDirectory(path.join(command.out, 'raw')),
          stages: command.stages,
          freezeMs: command.freezeMs,
          exporterRevision: command.revision,
          waveIds,
          dropPageSize: command.pageSize,
          concurrency: command.concurrency,
          bothMetric: command.bothMetric,
          resumeDrops: command.resume,
          log: (message) =>
            process.stderr.write(
              `[waves-export] ${new Date().toISOString()} ${message}\n`
            )
        }).run(),
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
      process.stderr.write(`${error.message}\n\n${WAVES_EXPORT_HELP}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
