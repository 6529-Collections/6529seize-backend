import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import {
  ArtworkDocumentationService,
  artworkDocumentationService
} from '../artwork-documentation.service';
import { AD_MUSEUM_RECORDS } from '../artwork-documentation.tables';
import { parseJson } from '../artwork-documentation.db';
import { ContextAccess, Mutation } from '../artwork-documentation.types';
import { digest, fail } from '../artwork-documentation.validation';
import { artworkAssetsService } from '../assets/artwork-assets.service';
import { publicationAssetAccess } from '../assets/artwork-assets.policy';
import {
  MUSEUM_RECORD_DEFINITIONS,
  museumRecordDefinition
} from './museum-record.catalogue';
import {
  museumEvidenceIds,
  MuseumRecordInput,
  validateMuseumRecord
} from './museum-record.validation';

interface MuseumRecordRow {
  id: string;
  context_id: string;
  actor_profile_id: string;
  kind: string;
  supersedes_id: string | null;
  source_revision_id: string | null;
  source_draft_version: number;
  payload_json: unknown;
  sha256: string;
  created_at: number;
}
interface MuseumRecordPayload extends MuseumRecordInput {
  evidence: { asset_id: string; sha256: string; size_bytes: number }[];
  stream_schema: string;
  recording_basis: 'database_account_authentication';
}

// A record can contain 150 kB of writing plus evidence. Ten full records keep
// even escaped API Gateway responses below the Lambda synchronous payload limit.
const RECORD_PAGE_SIZE = 10;

/** An immutable, attributed museum journal; adding a record never reconfirms artist writing. */
export class MuseumRecordService {
  constructor(
    private readonly core: ArtworkDocumentationService = artworkDocumentationService
  ) {}

  async list(id: string, ctx: RequestContext, before?: string) {
    const access = await this.core.authorizeContext(id, ctx);
    const capabilities = await this.core.mutationCapabilities(access, ctx);
    const records = await this.rows(id, ctx, before);
    return {
      context_id: id,
      draft_version: access.context.draft_version,
      definitions: MUSEUM_RECORD_DEFINITIONS,
      allowed_kinds: MUSEUM_RECORD_DEFINITIONS.filter(
        (item) =>
          !ctx.authenticationContext?.isAuthenticatedAsProxy() &&
          capabilities.review_lanes.includes(item.lane)
      ).map((item) => item.kind),
      records: records
        .slice(0, RECORD_PAGE_SIZE)
        .map((row) => this.project(row)),
      next_cursor:
        records.length > RECORD_PAGE_SIZE
          ? records[RECORD_PAGE_SIZE - 1].id
          : null
    };
  }

  private async rows(id: string, ctx: RequestContext, before?: string) {
    const cursor = before
      ? await this.core.db.one<MuseumRecordRow>(
          `SELECT * FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id AND id=:before`,
          { id, before },
          ctx
        )
      : null;
    if (before && !cursor) fail(422, 'INVALID_CURSOR');
    return this.core.db.query<MuseumRecordRow>(
      `SELECT * FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id${cursor ? ' AND (created_at < :created OR (created_at = :created AND id < :cursor))' : ''} ORDER BY created_at DESC,id DESC LIMIT ${RECORD_PAGE_SIZE + 1}`,
      { id, created: cursor?.created_at ?? 0, cursor: cursor?.id ?? '' },
      ctx
    );
  }

  private project(row: MuseumRecordRow) {
    return {
      id: row.id,
      context_id: row.context_id,
      actor_profile_id: row.actor_profile_id,
      source_revision_id: row.source_revision_id,
      source_draft_version: row.source_draft_version,
      sha256: row.sha256,
      created_at: Number(row.created_at),
      payload: parseJson<MuseumRecordPayload>(row.payload_json)
    };
  }

  async append(
    id: string,
    body: unknown,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    if (ctx.authenticationContext?.isAuthenticatedAsProxy())
      fail(403, 'DIRECT_REVIEWER_REQUIRED');
    const reference = await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        if (mutation.expectedVersion !== access.context.draft_version)
          fail(409, 'DRAFT_CONFLICT');
        if (access.context.lifecycle !== 'active')
          fail(409, 'CONTEXT_ARCHIVED');
        if (
          access.context.profile.version !== 3 ||
          access.context.profile.intake_mode !== 'publication_only'
        )
          fail(422, 'MUSEUM_PROFILE_REQUIRED');
        const input = validateMuseumRecord(body, access.context);
        const definition = museumRecordDefinition(input.kind)!;
        if (!access.capabilities.review_lanes.includes(definition.lane))
          fail(403, 'REVIEW_NOT_ALLOWED');
        await this.validateSupersession(id, input, access, transaction);
        await this.validateConditionReferences(id, input, transaction);
        const evidence = await this.evidence(input, access, transaction);
        const payload: MuseumRecordPayload = {
          ...input,
          evidence,
          stream_schema: definition.stream_schema,
          recording_basis: 'database_account_authentication'
        };
        const recordId = randomUUID();
        const createdAt = Date.now();
        const source = {
          id: recordId,
          context_id: id,
          actor_profile_id: access.actorProfileId,
          source_revision_id: access.context.latest_revision_id,
          source_draft_version: access.context.draft_version,
          created_at: createdAt,
          payload
        };
        await this.core.db.insert(
          AD_MUSEUM_RECORDS,
          {
            id: recordId,
            context_id: id,
            actor_profile_id: access.actorProfileId,
            kind: input.kind,
            supersedes_id: input.supersedes_id ?? null,
            source_revision_id: source.source_revision_id,
            source_draft_version: source.source_draft_version,
            payload_json: JSON.stringify(payload),
            sha256: digest(source),
            created_at: createdAt
          },
          transaction
        );
        await this.core.audit(
          access,
          'museum_record_appended',
          { record_id: recordId, kind: input.kind },
          transaction
        );
        return { record_id: recordId };
      },
      false
    );
    // Recheck access even when the idempotency result came from an earlier request.
    await this.core.authorizeContext(id, ctx);
    const row = await this.core.db.one<MuseumRecordRow>(
      `SELECT * FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id AND id=:recordId`,
      { id, recordId: reference.record_id },
      ctx
    );
    if (!row) fail(404, 'UNAVAILABLE');
    return this.project(row);
  }

  private async validateSupersession(
    id: string,
    input: MuseumRecordInput,
    access: ContextAccess,
    ctx: RequestContext
  ) {
    if (!input.supersedes_id) return;
    const previous = await this.core.db.one<MuseumRecordRow>(
      `SELECT * FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id AND id=:recordId`,
      { id, recordId: input.supersedes_id },
      ctx
    );
    if (
      !previous ||
      previous.kind !== input.kind ||
      previous.actor_profile_id !== access.actorProfileId
    )
      fail(403, 'MUSEUM_SUPERSESSION_NOT_ALLOWED');
    const successor = await this.core.db.one<{ id: string }>(
      `SELECT id FROM ${AD_MUSEUM_RECORDS} WHERE supersedes_id=:recordId`,
      { recordId: previous.id },
      ctx
    );
    if (successor) fail(409, 'MUSEUM_RECORD_SUPERSEDED');
  }

  private async validateConditionReferences(
    id: string,
    input: MuseumRecordInput,
    ctx: RequestContext
  ): Promise<void> {
    if (input.kind !== 'loan') return;
    for (const field of [
      'outbound_condition_record_id',
      'return_condition_record_id'
    ]) {
      const recordId = input.details[field];
      if (typeof recordId !== 'string') continue;
      const record = await this.core.db.one<{ kind: string }>(
        `SELECT kind FROM ${AD_MUSEUM_RECORDS} WHERE context_id=:id AND id=:recordId`,
        { id, recordId },
        ctx
      );
      if (record?.kind !== 'condition')
        fail(422, 'INVALID_CONDITION_REFERENCE');
    }
  }

  private async evidence(
    input: MuseumRecordInput,
    access: ContextAccess,
    ctx: RequestContext
  ) {
    const result: MuseumRecordPayload['evidence'] = [];
    for (const assetId of museumEvidenceIds(input)) {
      const link = access.context.asset_links.find(
        (item) => item.asset_id === assetId
      );
      if (
        !link ||
        link.intended_visibility !== 'public_record' ||
        !this.core.canReadAssetLink(link, access)
      )
        fail(422, 'PUBLIC_MUSEUM_EVIDENCE_REQUIRED');
      const manifest = await artworkAssetsService.validateReadyAsset(
        access.context.id,
        assetId,
        {
          actorProfileId: access.actorProfileId,
          canEdit: false,
          canReadArchivalFiles: access.capabilities.read_archival_files,
          canReadRightsEvidence: access.capabilities.read_rights_evidence,
          canReadRestricted: false,
          ...publicationAssetAccess(access.context)
        },
        ctx.connection
      );
      if (!manifest.sha256) fail(409, 'ASSET_NOT_READY');
      result.push({
        asset_id: assetId,
        sha256: manifest.sha256,
        size_bytes: manifest.size_bytes
      });
    }
    return result;
  }
}

export const museumRecordService = new MuseumRecordService();
