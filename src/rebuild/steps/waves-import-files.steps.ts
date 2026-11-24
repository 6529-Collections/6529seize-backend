import { Logger } from '@/logging';
import { RebuildContext } from '@/rebuild/manifest.types';
import { dbSupplier } from '@/sql-executor';
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
 * Rebuilder: 6529.io's drops from before the waves switch (drops and
 * drops_parts) from the drop archives the chain's waves import committed,
 * read at the run's mark. The files source serves the Waves v1 file and the
 * archives under the ids in DROP_ARCHIVE_FILE_IDS (layoutSnapshotFiles
 * makes that directory from the snapshot tooling's output).
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
  const report = await importDropArchives({
    chain: gatewayDropArchiveChain(gateway, ctx.mark.chainHeight),
    files: httpDropArchiveFiles(files),
    writer: dbDropArchiveWriter(dbSupplier()),
    log: (message) => logger.info(message)
  });
  logger.info(
    `[DROP ARCHIVES] archives ${report.archives}, written ${report.written}, drops ${report.drops}, parts ${report.parts}, refused ${report.refused.length}`
  );
  assertNoRefusals(report);
}
