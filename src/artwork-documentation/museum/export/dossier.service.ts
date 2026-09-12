import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import {
  artworkDocumentationService,
  ArtworkDocumentationService,
  confirmationStatus
} from '../../artwork-documentation.service';
import { AD_DOSSIER_EXPORTS } from '../../artwork-documentation.tables';
import { ContextAccess, Mutation } from '../../artwork-documentation.types';
import {
  digest,
  fail,
  matchesSchema
} from '../../artwork-documentation.validation';
import { StoredAsset } from '../../assets/artwork-assets.types';
import { DossierExportRow, DossierSnapshot } from './dossier.types';
import { compileDossier, dossierSourceHash } from './dossier';
import { dossierStorage } from './dossier.storage';
import { dossierAssetIds } from './dossier-history';
import {
  DOSSIER_ASSET_SELECTION,
  DOSSIER_HISTORY_SELECTIONS,
  dossierSelectionBytes,
  dossierSelectionSql,
  requireDossierBytes
} from './dossier-capacity';

function requireExportAccess(access: ContextAccess): void {
  if (
    !access.isArtist &&
    (!access.capabilities.read_archival_files ||
      !access.capabilities.read_rights_evidence ||
      !access.capabilities.read_source_receipts)
  )
    fail(403, 'DOSSIER_EXPORT_NOT_ALLOWED');
  if (
    access.context.profile.version !== 3 ||
    access.context.profile.intake_mode !== 'publication_only'
  )
    fail(422, 'MUSEUM_PROFILE_REQUIRED');
  if (
    access.context.restricted_paths.length ||
    Object.values(access.context.modules).some((answers) =>
      Object.values(answers).some(
        (answer) => answer.intended_visibility !== 'public_record'
      )
    ) ||
    access.context.asset_links.some(
      (link) => link.intended_visibility !== 'public_record'
    )
  )
    fail(422, 'PUBLICATION_REVIEW_REQUIRED');
}

export class ArtworkDossierService {
  constructor(
    private readonly core: ArtworkDocumentationService = artworkDocumentationService
  ) {}

  private async snapshot(
    access: ContextAccess,
    ctx: RequestContext
  ): Promise<DossierSnapshot> {
    requireExportAccess(access);
    const context = access.context;
    if (!ctx.connection) fail(500, 'TRANSACTION_REQUIRED');
    const params = { id: context.id };
    const selections = Object.values(DOSSIER_HISTORY_SELECTIONS);
    const historyBytes = await Promise.all(
      selections.map((selection) =>
        dossierSelectionBytes(this.core.db, selection, params, ctx)
      )
    );
    requireDossierBytes(
      Buffer.byteLength(JSON.stringify(context)) +
        historyBytes.reduce((total, size) => total + size, 4096)
    );
    const [museumRecords, sources, revisions, reviewHistory] =
      await Promise.all([
        this.core.db.query<Record<string, unknown>>(
          dossierSelectionSql(DOSSIER_HISTORY_SELECTIONS.museum),
          params,
          ctx
        ),
        this.core.db.query<Record<string, unknown>>(
          dossierSelectionSql(DOSSIER_HISTORY_SELECTIONS.sources),
          params,
          ctx
        ),
        this.core.db.query<Record<string, unknown>>(
          dossierSelectionSql(DOSSIER_HISTORY_SELECTIONS.revisions),
          params,
          ctx
        ),
        this.core.db.query<Record<string, unknown>>(
          dossierSelectionSql(DOSSIER_HISTORY_SELECTIONS.reviews),
          params,
          ctx
        )
      ]);
    if (
      museumRecords.length > 10000 ||
      sources.length > 10000 ||
      revisions.length > 1000 ||
      reviewHistory.length > 10000
    )
      fail(413, 'DOSSIER_RECORD_LIMIT');
    const revision =
      revisions.find((item) => item.id === context.latest_revision_id) ?? null;
    if (context.latest_revision_id && !revision)
      fail(409, 'DOSSIER_HISTORY_INCOMPLETE');
    const linked = dossierAssetIds(context, revisions, museumRecords);
    if (linked.size > DOSSIER_ASSET_SELECTION.limit)
      fail(413, 'DOSSIER_RECORD_LIMIT');
    const snapshot: DossierSnapshot = {
      context,
      assets: [],
      museum_records: museumRecords,
      source_receipts: sources,
      confirmation: confirmationStatus(
        context.draft_version,
        revision ? Number(revision.source_draft_version) : undefined
      ) as DossierSnapshot['confirmation'],
      confirmed_revision: revision,
      artist_revisions: revisions,
      review_history: reviewHistory
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(snapshot));
    requireDossierBytes(baseBytes);
    const assetParams = { id: context.id, assetIds: Array.from(linked) };
    const assets = linked.size
      ? await this.loadAssets(assetParams, baseBytes, ctx)
      : [];
    if (
      assets.length !== linked.size ||
      assets.some(
        (asset) =>
          asset.state !== 'ready' ||
          asset.scan_status !== 'NO_THREATS_FOUND' ||
          !asset.sha256 ||
          !asset.object_version ||
          asset.intended_visibility !== 'public_record'
      )
    )
      fail(409, 'DOSSIER_FILES_NOT_READY');
    snapshot.assets = assets;
    requireDossierBytes(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    return snapshot;
  }

  private async loadAssets(
    params: { id: string; assetIds: string[] },
    baseBytes: number,
    ctx: RequestContext
  ) {
    const assetBytes = await dossierSelectionBytes(
      this.core.db,
      DOSSIER_ASSET_SELECTION,
      params,
      ctx
    );
    requireDossierBytes(baseBytes + assetBytes);
    return this.core.db.query<StoredAsset>(
      dossierSelectionSql(DOSSIER_ASSET_SELECTION),
      params,
      ctx
    );
  }

  async inspect(id: string, ctx: RequestContext) {
    return this.core.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const transaction = { ...ctx, connection };
        const access = await this.core.authorizeContext(id, transaction, true);
        const snapshot = await this.snapshot(access, transaction);
        const compiled = compileDossier(snapshot);
        return {
          context_id: id,
          draft_version: access.context.draft_version,
          source_sha256: dossierSourceHash(snapshot),
          confirmation: snapshot.confirmation,
          files: compiled.manifest,
          issues: compiled.issues,
          can_export: !compiled.issues.some(
            (issue) => issue.severity === 'error'
          ),
          publication_state: 'database_draft'
        };
      }
    );
  }

  async create(
    id: string,
    body: unknown,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    if (
      !matchesSchema(body, {
        type: 'object',
        additionalProperties: false,
        required: ['source_sha256'],
        properties: {
          source_sha256: { type: 'string', minLength: 64, maxLength: 64 }
        }
      })
    )
      fail(422, 'INVALID_DOSSIER_REQUEST');
    const expected = (body as { source_sha256: string }).source_sha256;
    const initial = await this.core.authorizeContext(id, ctx);
    requireExportAccess(initial);
    const reference = await this.core.db.idempotent(
      digest([initial.actorProfileId, mutation.route, mutation.key]),
      digest(body),
      ctx,
      async (transaction) => {
        const access = await this.core.authorizeContext(id, transaction, true);
        requireExportAccess(access);
        if (mutation.expectedVersion !== access.context.draft_version)
          fail(409, 'DRAFT_CONFLICT');
        const snapshot = await this.snapshot(access, transaction);
        if (dossierSourceHash(snapshot) !== expected)
          fail(409, 'DOSSIER_SOURCE_CHANGED');
        if (
          compileDossier(snapshot).issues.some(
            (issue) => issue.severity === 'error'
          )
        )
          fail(422, 'DOSSIER_VALIDATION_FAILED');
        const active = await this.core.db.one<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${AD_DOSSIER_EXPORTS} WHERE context_id=:id AND created_at>:since`,
          { id, since: Date.now() - 86400000 },
          transaction
        );
        if (Number(active?.count ?? 0) >= 5) fail(429, 'DOSSIER_EXPORT_LIMIT');
        const exportId = randomUUID();
        await this.core.db.insert(
          AD_DOSSIER_EXPORTS,
          {
            id: exportId,
            context_id: id,
            actor_profile_id: access.actorProfileId,
            source_sha256: expected,
            state: 'queued',
            snapshot_json: JSON.stringify(snapshot),
            object_version: null,
            sha256: null,
            size_bytes: null,
            failure_code: null,
            created_at: Date.now(),
            expires_at: Date.now() + 7 * 86400000,
            lease_until: 0,
            attempts: 0
          },
          transaction
        );
        await this.core.audit(
          access,
          'dossier_export_requested',
          { export_id: exportId, source_sha256: expected },
          transaction
        );
        return { export_id: exportId };
      }
    );
    return this.get(id, reference.export_id, ctx);
  }

  async get(id: string, exportId: string, ctx: RequestContext) {
    const access = await this.core.authorizeContext(id, ctx);
    requireExportAccess(access);
    const row = await this.core.db.one<DossierExportRow>(
      `SELECT id,context_id,source_sha256,state,created_at,expires_at,object_version,sha256,size_bytes,failure_code FROM ${AD_DOSSIER_EXPORTS} WHERE context_id=:id AND id=:exportId`,
      { id, exportId },
      ctx
    );
    if (!row) fail(404, 'UNAVAILABLE');
    const expired = Number(row.expires_at) <= Date.now();
    return {
      id: row.id,
      context_id: row.context_id,
      source_sha256: row.source_sha256,
      state: expired ? 'expired' : row.state,
      created_at: Number(row.created_at),
      expires_at: Number(row.expires_at),
      download_url:
        !expired && row.state === 'ready'
          ? await dossierStorage.download(row)
          : null,
      sha256: row.sha256,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      failure_code: row.failure_code
    };
  }
}

export const artworkDossierService = new ArtworkDossierService();
