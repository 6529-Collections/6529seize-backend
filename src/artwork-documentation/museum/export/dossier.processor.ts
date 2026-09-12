import { RequestContext } from '@/request.context';
import {
  artworkDocumentationDb,
  ArtworkDocumentationDb,
  parseJson
} from '../../artwork-documentation.db';
import { AD_DOSSIER_EXPORTS } from '../../artwork-documentation.tables';
import { artworkAssetStorage } from '../../assets/artwork-assets.storage';
import { compileDossier, dossierSourceHash, originalPath } from './dossier';
import { DossierExportRow, DossierSnapshot } from './dossier.types';
import { dossierStorage, DossierStorage } from './dossier.storage';
import { TarEntry, verifiedTar } from './tar';
import { wrapDossierInOcfl, OCFL_BAG_PREFIX } from './ocfl';

export class DossierProcessor {
  constructor(
    private readonly db: ArtworkDocumentationDb = artworkDocumentationDb,
    private readonly storage: DossierStorage = dossierStorage
  ) {}

  private async claim(): Promise<DossierExportRow | null> {
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const ctx = { connection } as RequestContext;
      await this.db.query(
        `UPDATE ${AD_DOSSIER_EXPORTS} SET state='failed',failure_code='DOSSIER_EXPORT_RETRY_LIMIT' WHERE state='processing' AND lease_until<:now AND attempts>=3`,
        { now: Date.now() },
        ctx
      );
      const row = await this.db.one<DossierExportRow>(
        `SELECT * FROM ${AD_DOSSIER_EXPORTS} WHERE state IN ('queued','processing') AND lease_until<:now AND expires_at>:now AND attempts<3 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        { now: Date.now() },
        ctx
      );
      if (!row) return null;
      const lease = Date.now() + 18 * 60 * 1000;
      await this.db.query(
        `UPDATE ${AD_DOSSIER_EXPORTS} SET state='processing',lease_until=:lease,attempts=attempts+1 WHERE id=:id`,
        { id: row.id, lease },
        ctx
      );
      return { ...row, lease_until: lease, attempts: Number(row.attempts) + 1 };
    });
  }

  async tick(): Promise<boolean> {
    const row = await this.claim();
    if (!row) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12 * 60 * 1000);
    try {
      const snapshot = parseJson<DossierSnapshot>(row.snapshot_json);
      if (dossierSourceHash(snapshot) !== row.source_sha256)
        throw new Error('Dossier source digest mismatch');
      const result = await this.storage.upload(
        row.id,
        verifiedTar(this.entries(snapshot, controller.signal)),
        controller.signal
      );
      await this.db.query(
        `UPDATE ${AD_DOSSIER_EXPORTS} SET state='ready',object_version=:object_version,sha256=:sha256,size_bytes=:size_bytes,failure_code=NULL WHERE id=:id AND lease_until=:lease`,
        { ...result, id: row.id, lease: row.lease_until },
        {} as RequestContext
      );
    } catch {
      // Do not send original filenames, metadata, storage locations, or parser reports to logs.
      await this.db.query(
        `UPDATE ${AD_DOSSIER_EXPORTS} SET state='failed',failure_code=:code WHERE id=:id AND lease_until=:lease`,
        {
          id: row.id,
          lease: row.lease_until,
          code: controller.signal.aborted
            ? 'DOSSIER_EXPORT_TIMEOUT'
            : 'DOSSIER_EXPORT_FAILED'
        },
        {} as RequestContext
      );
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  private async *entries(
    snapshot: DossierSnapshot,
    signal: AbortSignal
  ): AsyncGenerator<TarEntry> {
    const dossier = compileDossier(snapshot);
    const ocfl = wrapDossierInOcfl(snapshot, dossier);
    for (const file of ocfl.files)
      yield { ...file, size_bytes: file.bytes.length, source: [file.bytes] };
    for (const asset of snapshot.assets) {
      const stream = await artworkAssetStorage.read(asset, signal);
      try {
        yield {
          path: OCFL_BAG_PREFIX + originalPath(asset),
          size_bytes: Number(asset.size_bytes),
          sha256: asset.sha256!,
          source: stream
        };
      } finally {
        stream.destroy();
      }
    }
    for (const report of dossier.reports) {
      const stream = await this.storage.readReport(
        report.bucket,
        report.key,
        signal
      );
      try {
        yield {
          path: OCFL_BAG_PREFIX + report.path,
          size_bytes: report.size_bytes,
          sha256: report.sha256,
          source: stream
        };
      } finally {
        stream.destroy();
      }
    }
  }
}
export const dossierProcessor = new DossierProcessor();
