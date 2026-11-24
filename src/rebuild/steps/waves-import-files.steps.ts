import { Logger } from '@/logging';
import { SqlExecutor } from '@/sql-executor';
import {
  DropArchiveReport,
  importDropArchives
} from '@/waves-import-files/drop-archive.reader';
import {
  dbDropArchiveWriter,
  gatewayDropArchiveChain,
  httpDropArchiveFiles
} from '@/waves-import-files/drop-archive.sources';

const logger = Logger.get('WAVES_REBUILD_IMPORT_FILES');

/** A refusal count above 0 fails the step, and with it the run. */
export function assertNoRefusals(report: DropArchiveReport): void {
  if (!report.refused.length) return;
  const first = report.refused
    .slice(0, 5)
    .map((r) => `${r.waveId ?? 'all archives'}: ${r.reason}`)
    .join('; ');
  throw new Error(
    `[DROP ARCHIVES REFUSED] ${report.refused.length} refused, none of their rows written: ${first}`
  );
}

/**
 * 6529.io's drops from before the waves switch, for a rebuild: reads the
 * drop archives the chain's waves import committed from the files source
 * at `files` (the Waves v1 file, the archives and the wave documents,
 * under the ids in DROP_ARCHIVE_FILE_IDS; layoutSnapshotFiles makes that
 * directory from the snapshot tooling's output), checks them against the
 * import at `height` (null: the gateway's finalized height), and writes
 * drops and drops_parts. Fails on any refusal. Returns the report, which
 * carries each imported wave's description drop.
 *
 * drops and drops_parts have one rebuilder, the chain mirror's step, which
 * runs this first (its DropArchivesImport) and then the mirror's rebuild;
 * this is not a step of its own, and it runs once per rebuild.
 */
export async function importDropArchivesFromSources(
  sources: { readonly files: string; readonly gateway: string },
  db: () => SqlExecutor,
  height: number | null = null
): Promise<DropArchiveReport> {
  const report = await importDropArchives({
    chain: gatewayDropArchiveChain(sources.gateway, height),
    files: httpDropArchiveFiles(sources.files),
    writer: dbDropArchiveWriter(db()),
    log: (message) => logger.info(message)
  });
  logger.info(
    `[DROP ARCHIVES] archives ${report.archives}, written ${report.written}, drops ${report.drops}, parts ${report.parts}, refused ${report.refused.length}, skipped ${report.skipped.length}, description drops ${report.descriptionDropIds.size}`
  );
  if (report.skipped.length) {
    logger.warn(
      `[DROP ARCHIVES] ${report.skipped.length} archives of waves the import has no row for, not written, first: ${report.skipped
        .slice(0, 5)
        .map((s) => s.legacyWave)
        .join(', ')}`
    );
  }
  if (report.descriptionsUnresolved.length) {
    logger.warn(
      `[DROP ARCHIVES] ${report.descriptionsUnresolved.length} imported waves without a description drop, first: ${report.descriptionsUnresolved
        .slice(0, 5)
        .map((u) => `${u.legacyWave} (${u.reason})`)
        .join(', ')}`
    );
  }
  assertNoRefusals(report);
  return report;
}
