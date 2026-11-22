import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  IDENTITY_EXPORT_HELP,
  IdentityExportCommand,
  IdentityExportUsageError,
  parseExtraIds,
  parseIdentityExportCommand
} from './cli-options';

function gitRevision(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) {
      return head;
    }
  } catch {
    // Not a git checkout: the caller must pass --revision.
  }
  throw new IdentityExportUsageError(
    'No exporter revision: pass --revision <40-hex commit> or set EXPORTER_REVISION'
  );
}

async function runExport(command: IdentityExportCommand) {
  const extraProfileIds = command.extraIdsFile
    ? parseExtraIds(fs.readFileSync(command.extraIdsFile, 'utf8'))
    : [];
  const exporterRevision = command.revision ?? gitRevision();
  // The shared environment and DB startup log to stdout: keep stdout for the
  // one JSON summary.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const { doInDbContext } = await import('@/secrets');
    const { withReadOnlySnapshot } = await import('@/db-api');
    const { sqlExecutor } = await import('@/sql-executor');
    const { SqlIdentityExportSource } = await import('./identity-export.db');
    const { buildIdentityExport } = await import('./identity-export.service');
    const { writeJsonDocument } = await import('./identity-export.writer');
    return await doInDbContext(
      () =>
        withReadOnlySnapshot(async (connection) => {
          const source = new SqlIdentityExportSource(
            <T>(sql: string, params?: Record<string, unknown>) =>
              sqlExecutor.execute<T>(sql, params, {
                wrappedConnection: connection
              })
          );
          const document = await buildIdentityExport(source, {
            bulkThreshold: command.bulk,
            extraProfileIds,
            includeDelegations: command.includeDelegations,
            freezeMs: command.freezeMs,
            exporterRevision,
            log: (message) =>
              process.stderr.write(`[identity-export] ${message}\n`)
          });
          await writeJsonDocument(command.out, { ...document });
          return {
            out: command.out,
            format: document.format,
            tdh_block: document.tdh_block,
            freeze_ms: document.freeze_ms,
            stats: document.stats,
            notes: document.notes
          };
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
  const command = parseIdentityExportCommand(args);
  if (command.command === 'help') {
    process.stdout.write(IDENTITY_EXPORT_HELP);
    return;
  }
  const summary = await runExport(command);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof IdentityExportUsageError) {
      process.stderr.write(`${error.message}\n\n${IDENTITY_EXPORT_HELP}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
