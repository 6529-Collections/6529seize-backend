import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { IdentityExportNotReadyError } from './identity-export.errors';
import {
  IDENTITY_EXPORT_HELP,
  IdentityExportCommand,
  identityFreezeSettingProblem,
  IdentityExportUsageError,
  parseCmsFields,
  parseExtraIds,
  parseIdentityExportCommand
} from './cli-options';
import {
  noCmsFieldsProblem,
  profileSiteManifestProblem
} from './profile-site-manifest';
import { CmsFieldsFile } from './identity-export.types';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function runExport(command: IdentityExportCommand) {
  // Dates read from MySQL (statements, ratings) in UTC, whatever the host.
  process.env.TZ = 'UTC';
  // An existing file is refused before any read.
  const { checkOutPath } = await import('./identity-export.writer');
  checkOutPath(command.out, command.overwrite);
  const extraIdsBytes = command.extraIdsFile
    ? fs.readFileSync(command.extraIdsFile)
    : null;
  const extraProfileIds = extraIdsBytes
    ? parseExtraIds(extraIdsBytes.toString('utf8'))
    : [];
  const cmsBytes = command.cmsFieldsFile
    ? fs.readFileSync(command.cmsFieldsFile)
    : null;
  // An empty file (a site export with no sites) only with its manifest.
  const cmsFields = cmsBytes
    ? parseCmsFields(cmsBytes.toString('utf8'), {
        allowEmpty: command.cmsManifestFile !== null
      })
    : undefined;
  // The profile site run that wrote the values vouches for them: at the
  // freeze, a whole, usable run of that freeze.
  const manifestBytes = command.cmsManifestFile
    ? fs.readFileSync(command.cmsManifestFile)
    : null;
  if (cmsBytes && manifestBytes) {
    const problem = profileSiteManifestProblem(
      manifestBytes.toString('utf8'),
      sha256(cmsBytes),
      command.freezeMs
    );
    if (problem) {
      throw new IdentityExportUsageError(
        `--cms-manifest ${command.cmsManifestFile}: ${problem}`
      );
    }
  }
  const cmsFieldsFile: CmsFieldsFile | null = cmsBytes
    ? {
        count: Object.keys(cmsFields ?? {}).length,
        sha256: sha256(cmsBytes),
        manifest: manifestBytes
          ? { key: null, sha256: sha256(manifestBytes) }
          : null
      }
    : null;
  // At the freeze an empty set of values (no sites) only acknowledged.
  if (command.freezeMs !== null && cmsFields) {
    const empty = noCmsFieldsProblem(
      Object.keys(cmsFields).length,
      command.acceptNoCmsFields
    );
    if (empty) throw new IdentityExportUsageError(empty);
  }
  if (command.notice) {
    process.stderr.write(`[identity-export] ${command.notice}\n`);
  }
  // The shared environment and DB startup log to stdout: keep stdout for the
  // one JSON summary.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    // The environment (the secrets in Lambda) and db-api's pools only: no
    // TypeORM connection to the writer, which doInDbContext would open.
    const { prepEnvironment } = await import('@/env');
    const dbApi = await import('@/db-api');
    // The module, not its value: db-api's connect() installs the executor.
    const executor = await import('@/sql-executor');
    const { SqlIdentityExportSource } = await import('./identity-export.db');
    const { buildIdentityExport } = await import('./identity-export.service');
    const { writeExportFile } = await import('./identity-export.writer');
    await prepEnvironment();
    // IDENTITY_FREEZE_AT as 6529.io runs with it, the .env file included.
    if (command.freezeMs !== null) {
      const problem = identityFreezeSettingProblem(
        command.freezeMs,
        process.env.IDENTITY_FREEZE_AT
      );
      if (problem) throw new IdentityExportUsageError(problem);
    }
    // The read pool behind the snapshot is db-api's; its write pool is
    // created but never connected. connect() calls process.exit() without a
    // code when the DB settings are missing.
    process.exitCode = 1;
    await dbApi.connect();
    process.exitCode = 0;
    try {
      return await dbApi.withReadOnlySnapshot(async (connection) => {
        const source = new SqlIdentityExportSource(
          <T>(sql: string, params?: Record<string, unknown>) =>
            executor.sqlExecutor.execute<T>(sql, params, {
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
          acceptRatingsChangedAfterFreeze:
            command.acceptRatingsChangedAfterFreeze,
          acceptMissingExtraIds: command.acceptMissingExtraIds,
          acceptProfileWritesAfterFreeze:
            command.acceptProfileWritesAfterFreeze,
          acceptUnmatchedCms: command.acceptUnmatchedCms,
          acceptConsolidationsAfterFreeze:
            command.acceptConsolidationsAfterFreeze,
          acceptNoExtraIds: command.acceptNoExtraIds,
          acceptNoCmsFields: command.acceptNoCmsFields,
          acceptBulk: command.acceptBulk,
          extraIdsFile: extraIdsBytes
            ? { count: extraProfileIds.length, sha256: sha256(extraIdsBytes) }
            : null,
          cmsFieldsFile,
          exporterRevision: command.revision,
          log: (message) =>
            process.stderr.write(`[identity-export] ${message}\n`)
        });
        await writeExportFile(command.out, { ...document }, command.overwrite);
        return {
          out: command.out,
          format: document.format,
          tdh_block: document.tdh_block,
          freeze_ms: document.freeze_ms,
          stats: document.stats,
          notes: document.notes
        };
      });
    } finally {
      try {
        await dbApi.disconnect();
      } catch (error) {
        // Logged: it never takes the place of the export's result or error.
        process.stderr.write(
          `[identity-export] closing the database pools failed: ${error}\n`
        );
      }
    }
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

/**
 * Runs the export and returns the process exit code: 0 written; 1 failed;
 * 2 a usage error; and the reasons the export is not ready
 * (NOT_READY_EXIT_CODES): 3 not the freeze day's TDH yet, 4 raters over the
 * chain's cap, 5 a change after the freeze, 6 waves-list ids missing, 7
 * profile site values unmatched. The file is written only on 0: on 3 to 7
 * nothing is written.
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
        `${error.message}: nothing was written; wait, or acknowledge, and run again (exit ${error.exitCode}: see --help)\n`
      );
      return error.exitCode;
    }
    if (error instanceof IdentityExportUsageError) {
      process.stderr.write(`${error.message}\n\n${IDENTITY_EXPORT_HELP}`);
      return 2;
    }
    process.stderr.write(`${(error as Error)?.stack ?? error}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
