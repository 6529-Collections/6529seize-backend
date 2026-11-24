import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
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
 * Reads the drop archives the chain's waves import committed, from the
 * files source at `files` (the Waves v1 file, the archives and the wave
 * documents, under the ids in DROP_ARCHIVE_FILE_IDS; layoutSnapshotFiles
 * makes that directory from the snapshot tooling's output), checked
 * against the import at `height` (null: the gateway's finalized height),
 * and writes drops and drops_parts. Fails on any refused archive. Returns
 * the report, with each imported wave's description drop.
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
    `[DROP ARCHIVES] archives ${report.archives}, written ${report.written}, drops ${report.drops}, parts ${report.parts}, refused ${report.refused.length}, description drops ${report.descriptionDropIds.size}`
  );
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

/**
 * Rebuilder: 6529.io's drops from before the waves switch (drops and
 * drops_parts) from the drop archives the chain's waves import committed,
 * read at the run's mark. See src/waves-import-files.
 */
export async function rebuildWavesImportFiles(
  ctx: RebuildContext
): Promise<void> {
  const { gateway, files } = ctx.sources;
  if (!gateway || !files) {
    throw new Error(
      `${ctx.stepId} reads the chain and the drop archives: the run needs a gateway and a files source`
    );
  }
  await importDropArchivesFromSources(
    { gateway, files },
    dbSupplier,
    ctx.mark.chainHeight
  );
}
