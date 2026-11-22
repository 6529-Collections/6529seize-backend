import * as fs from 'node:fs';
import { IdentityExportNotReadyError } from './identity-export.errors';
import {
  IDENTITY_EXPORT_HELP,
  IdentityExportCommand,
  IdentityExportUsageError,
  parseCmsFields,
  parseExtraIds,
  parseIdentityExportCommand
} from './cli-options';

async function runExport(command: IdentityExportCommand) {
  // Dates read from MySQL (statements, ratings) in UTC, whatever the host.
  process.env.TZ = 'UTC';
  // An existing file is refused before any read.
  const { checkOutPath } = await import('./identity-export.writer');
  checkOutPath(command.out, command.overwrite);
  const extraProfileIds = command.extraIdsFile
    ? parseExtraIds(fs.readFileSync(command.extraIdsFile, 'utf8'))
    : [];
  const cmsFields = command.cmsFieldsFile
    ? parseCmsFields(fs.readFileSync(command.cmsFieldsFile, 'utf8'))
    : undefined;
  const exporterRevision = command.revision;
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
    const { writeExportFile } = await import('./identity-export.writer');
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
            wavesListGiven: command.extraIdsFile !== null,
            includeDelegations: command.includeDelegations,
            cmsFields,
            freezeMs: command.freezeMs,
            expectTdhBlock: command.expectTdhBlock,
            acceptOverCredit: command.acceptOverCredit,
            acceptEditsAfterFreeze: command.acceptEditsAfterFreeze,
            exporterRevision,
            log: (message) =>
              process.stderr.write(`[identity-export] ${message}\n`)
          });
          await writeExportFile(
            command.out,
            { ...document },
            command.overwrite
          );
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
  process.stdout.write(`${JSON.stringify(summary, null, 2)}
`);
}

/**
 * Runs the export and returns the process exit code: 0 done, 1 failed,
 * 2 a usage error, 3 the database is not at the freeze day asked for.
 */
export async function runCli(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  try {
    await main(args);
    return 0;
  } catch (error) {
    if (error instanceof IdentityExportNotReadyError) {
      process.stderr.write(
        `${error.message}: wait for the freeze day's TDH run and its identity sync, then export again
`
      );
      return 3;
    }
    if (error instanceof IdentityExportUsageError) {
      process.stderr.write(`${error.message}

${IDENTITY_EXPORT_HELP}`);
      return 2;
    }
    process.stderr.write(`${(error as Error)?.stack ?? error}
`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
