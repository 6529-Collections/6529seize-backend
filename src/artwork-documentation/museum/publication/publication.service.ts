import { randomUUID } from 'node:crypto';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { Logger } from '@/logging';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { RequestContext } from '@/request.context';
import { parseJson } from '../../artwork-documentation.db';
import {
  artworkDocumentationService,
  ArtworkDocumentationService
} from '../../artwork-documentation.service';
import { AD_PUBLICATIONS } from '../../artwork-documentation.tables';
import {
  ContextAccess,
  Mutation,
  ValueSchema
} from '../../artwork-documentation.types';
import {
  digest,
  fail,
  matchesSchema,
  normalizeJson
} from '../../artwork-documentation.validation';
import { dossierSourceHash } from '../export/dossier';
import {
  artworkDossierService,
  ArtworkDossierService,
  requireExportAccess
} from '../export/dossier.service';
import { DossierSnapshot } from '../export/dossier.types';
import { compilePublication } from './publication-compiler';
import { publicationStorage, PublicationStore } from './publication.storage';
import {
  PUBLICATION_COMPILER_VERSION,
  PublicationBindings,
  PublicationRejectedError,
  PublicationRights,
  ResourceRole
} from './publication.types';

export interface PublicationRequest {
  source_sha256: string;
  selection: { asset_ids: string[] };
  bindings: PublicationBindings;
  rights: PublicationRights;
  roles: Record<string, ResourceRole>;
}
export interface PublicationRow {
  id: string;
  context_id: string;
  revision_id: string;
  actor_profile_id: string;
  version: number;
  state: 'published' | 'withdrawn';
  source_sha256: string;
  manifest_sha256: string;
  input_digest: string;
  manifest_url: string;
  input_json?: unknown;
  manifest_json?: unknown;
  compiler_version: string;
  storage_key: string | null;
  created_at: number;
  withdrawn_at: number | null;
}
export interface PublicationSummary {
  id: string;
  context_id: string;
  revision_id: string;
  version: number;
  state: 'published' | 'withdrawn';
  source_sha256: string;
  manifest_sha256: string;
  manifest_url: string;
  manifest_api_path: string;
  compiler_version: string;
  created_at: number;
  withdrawn_at: number | null;
}

export const PUBLIC_MANIFEST_PATH = (id: string) =>
  `/api/museum/iiif/${id}/manifest`;
const SUMMARY_COLUMNS =
  'id,context_id,revision_id,actor_profile_id,version,state,source_sha256,manifest_sha256,input_digest,manifest_url,compiler_version,storage_key,created_at,withdrawn_at';
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const url: ValueSchema = { type: 'string', maxLength: 2048 };
const REQUEST_SCHEMA: ValueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source_sha256', 'selection', 'bindings', 'rights', 'roles'],
  properties: {
    source_sha256: { type: 'string', minLength: 64, maxLength: 64 },
    selection: {
      type: 'object',
      additionalProperties: false,
      required: ['asset_ids'],
      properties: {
        asset_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { type: 'string', format: 'uuid' }
        }
      }
    },
    bindings: {
      type: 'object',
      additionalProperties: false,
      required: ['base_url', 'media'],
      properties: {
        base_url: url,
        homepage_url: url,
        media: { type: 'object', additionalProperties: true }
      }
    },
    rights: {
      type: 'object',
      additionalProperties: false,
      required: ['rights_uri', 'required_statement'],
      properties: {
        rights_uri: url,
        required_statement: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value'],
          properties: {
            label: { type: 'string', maxLength: 1000 },
            value: { type: 'string', maxLength: 1000 }
          }
        },
        provider: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label'],
          properties: { id: url, label: { type: 'string', maxLength: 1000 } }
        }
      }
    },
    roles: { type: 'object', additionalProperties: true }
  }
};

function summary(row: PublicationRow): PublicationSummary {
  return {
    id: row.id,
    context_id: row.context_id,
    revision_id: row.revision_id,
    version: Number(row.version),
    state: row.state,
    source_sha256: row.source_sha256,
    manifest_sha256: row.manifest_sha256,
    manifest_url: row.manifest_url,
    manifest_api_path: PUBLIC_MANIFEST_PATH(row.id),
    compiler_version: row.compiler_version,
    created_at: Number(row.created_at),
    withdrawn_at: row.withdrawn_at === null ? null : Number(row.withdrawn_at)
  };
}

export class ArtworkPublicationService {
  private readonly logger = Logger.get(this.constructor.name);
  constructor(
    private readonly core: ArtworkDocumentationService = artworkDocumentationService,
    private readonly dossier: ArtworkDossierService = artworkDossierService,
    private readonly storage: PublicationStore = publicationStorage
  ) {}

  private request(body: unknown): PublicationRequest {
    const value = normalizeJson(body);
    if (!matchesSchema(value, REQUEST_SCHEMA))
      fail(422, 'INVALID_PUBLICATION_REQUEST');
    const request = value as unknown as PublicationRequest;
    if (!/^[a-f0-9]{64}$/.test(request.source_sha256))
      fail(422, 'INVALID_PUBLICATION_REQUEST');
    return request;
  }

  private compile(snapshot: DossierSnapshot, request: PublicationRequest) {
    try {
      return compilePublication({
        snapshot,
        source_sha256: request.source_sha256,
        selection: request.selection,
        bindings: request.bindings,
        rights: request.rights,
        roles: request.roles,
        compiler_version: PUBLICATION_COMPILER_VERSION
      });
    } catch (error) {
      if (!(error instanceof PublicationRejectedError)) throw error;
      if (error.code === 'SOURCE_HASH_MISMATCH')
        fail(409, 'DOSSIER_SOURCE_CHANGED');
      return fail(422, error.code);
    }
  }

  /** The confirmed revision must be current and internally consistent before anything is published. */
  private requireConfirmedRevision(snapshot: DossierSnapshot): string {
    const revision = snapshot.confirmed_revision;
    if (snapshot.confirmation !== 'current' || !revision)
      fail(409, 'CONFIRMATION_REQUIRED');
    if (
      typeof revision.id !== 'string' ||
      digest(parseJson(revision.snapshot_json)) !== revision.sha256
    )
      fail(409, 'DOSSIER_HISTORY_INCOMPLETE');
    return revision.id;
  }

  async publish(
    id: string,
    body: unknown,
    mutation: Mutation,
    ctx: RequestContext
  ): Promise<PublicationSummary> {
    const request = this.request(body);
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
        const snapshot = await this.dossier.snapshot(access, transaction);
        const revisionId = this.requireConfirmedRevision(snapshot);
        if (dossierSourceHash(snapshot) !== request.source_sha256)
          fail(409, 'DOSSIER_SOURCE_CHANGED');
        const compiled = this.compile(snapshot, request);
        if (!compiled.validation.ok) fail(422, 'PUBLICATION_VALIDATION_FAILED');
        const existing = await this.core.db.one<{ id: string }>(
          `SELECT id FROM ${AD_PUBLICATIONS} WHERE context_id=:id AND source_sha256=:source AND input_digest=:input AND state='published' ORDER BY version DESC LIMIT 1`,
          {
            id,
            source: request.source_sha256,
            input: compiled.transformation.input_digest
          },
          transaction
        );
        if (existing) return { publication_id: existing.id };
        const latest = await this.core.db.one<{ max: number | null }>(
          `SELECT MAX(version) AS max FROM ${AD_PUBLICATIONS} WHERE context_id=:id`,
          { id },
          transaction
        );
        const publicationId = randomUUID();
        const manifestJson = canonicalizeJson(normalizeJson(compiled.manifest));
        await this.core.db.insert(
          AD_PUBLICATIONS,
          {
            id: publicationId,
            context_id: id,
            revision_id: revisionId,
            actor_profile_id: access.actorProfileId,
            version: Number(latest?.max ?? 0) + 1,
            state: 'published',
            source_sha256: request.source_sha256,
            manifest_sha256: compiled.manifest_sha256,
            input_digest: compiled.transformation.input_digest,
            manifest_url: String(compiled.manifest.id),
            input_json: JSON.stringify(request),
            manifest_json: manifestJson,
            compiler_version: compiled.transformation.compiler_version,
            storage_key: null,
            created_at: Date.now(),
            withdrawn_at: null
          },
          transaction
        );
        await this.core.audit(
          access,
          'artwork_publication_created',
          {
            publication_id: publicationId,
            revision_id: revisionId,
            source_sha256: request.source_sha256,
            manifest_sha256: compiled.manifest_sha256,
            input_digest: compiled.transformation.input_digest
          },
          transaction
        );
        return { publication_id: publicationId };
      }
    );
    await this.storeCopy(reference.publication_id, ctx);
    return this.get(id, reference.publication_id, ctx);
  }

  /** Best effort immutable copy; the API row remains the serving source of truth. */
  private async storeCopy(publicationId: string, ctx: RequestContext) {
    const row = await this.core.db.one<PublicationRow>(
      `SELECT id,manifest_sha256,manifest_json,storage_key FROM ${AD_PUBLICATIONS} WHERE id=:id`,
      { id: publicationId },
      ctx
    );
    if (!row || row.storage_key) return;
    try {
      const key = await this.storage.store({
        id: row.id,
        manifest_sha256: row.manifest_sha256,
        manifest_json:
          typeof row.manifest_json === 'string'
            ? row.manifest_json
            : JSON.stringify(row.manifest_json)
      });
      if (key)
        await this.core.db.query(
          `UPDATE ${AD_PUBLICATIONS} SET storage_key=:key WHERE id=:id AND storage_key IS NULL`,
          { id: row.id, key },
          ctx
        );
    } catch (error) {
      this.logger.warn(
        `Publication ${publicationId} immutable copy failed: ${String(error)}`
      );
    }
  }

  private async row(
    access: ContextAccess,
    publicationId: string,
    ctx: RequestContext,
    lock = false
  ): Promise<PublicationRow> {
    const row = await this.core.db.one<PublicationRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM ${AD_PUBLICATIONS} WHERE context_id=:id AND id=:publicationId${lock ? ' FOR UPDATE' : ''}`,
      { id: access.context.id, publicationId },
      ctx
    );
    if (!row) fail(404, 'UNAVAILABLE');
    return row;
  }

  async get(
    id: string,
    publicationId: string,
    ctx: RequestContext
  ): Promise<PublicationSummary> {
    const access = await this.core.authorizeContext(id, ctx);
    requireExportAccess(access);
    return summary(await this.row(access, publicationId, ctx));
  }

  async list(id: string, ctx: RequestContext): Promise<PublicationSummary[]> {
    const access = await this.core.authorizeContext(id, ctx);
    requireExportAccess(access);
    const rows = await this.core.db.query<PublicationRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM ${AD_PUBLICATIONS} WHERE context_id=:id ORDER BY version DESC LIMIT 200`,
      { id },
      ctx
    );
    return rows.map(summary);
  }

  async withdraw(
    id: string,
    publicationId: string,
    mutation: Mutation,
    ctx: RequestContext
  ): Promise<PublicationSummary> {
    if (!UUID.test(publicationId)) fail(404, 'UNAVAILABLE');
    const initial = await this.core.authorizeContext(id, ctx);
    requireExportAccess(initial);
    await this.core.db.idempotent(
      digest([initial.actorProfileId, mutation.route, mutation.key]),
      digest(mutation.body ?? null),
      ctx,
      async (transaction) => {
        const access = await this.core.authorizeContext(id, transaction, true);
        requireExportAccess(access);
        const row = await this.row(access, publicationId, transaction, true);
        if (row.state === 'published') {
          const now = Date.now();
          await this.core.db.query(
            `UPDATE ${AD_PUBLICATIONS} SET state='withdrawn', withdrawn_at=:now WHERE id=:publicationId AND state='published'`,
            { publicationId, now },
            transaction
          );
          await this.core.audit(
            access,
            'artwork_publication_withdrawn',
            { publication_id: publicationId, version: Number(row.version) },
            transaction
          );
        }
        return { publication_id: publicationId };
      }
    );
    return this.get(id, publicationId, ctx);
  }

  /** Public, unauthenticated read of a published manifest. Withdrawn publications answer 410. */
  async publicManifest(
    publicationId: string
  ): Promise<Record<string, unknown>> {
    if (!UUID.test(publicationId))
      throw new NotFoundException('Publication not found');
    const row = await this.core.db.one<
      Pick<PublicationRow, 'state' | 'manifest_json'>
    >(
      `SELECT state,manifest_json FROM ${AD_PUBLICATIONS} WHERE id=:id`,
      { id: publicationId },
      {}
    );
    if (!row) throw new NotFoundException('Publication not found');
    if (row.state !== 'published')
      throw new CustomApiCompliantException(
        410,
        'Publication withdrawn',
        'PUBLICATION_WITHDRAWN'
      );
    return parseJson<Record<string, unknown>>(row.manifest_json);
  }
}

export const artworkPublicationService = new ArtworkPublicationService();
