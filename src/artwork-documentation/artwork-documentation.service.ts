import { randomUUID, createHash } from 'node:crypto';
import { RequestContext } from '@/request.context';
import {
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  DROP_METADATA_TABLE
} from '@/constants';
import {
  ArtworkDocumentationDb,
  artworkDocumentationDb,
  parseJson
} from './artwork-documentation.db';
import {
  AD_ARTISTS,
  AD_ARTIST_REVISIONS,
  AD_CONTEXTS,
  AD_DROP_LINKS,
  AD_EVENTS,
  AD_GRANTS,
  AD_REVISIONS,
  AD_REVIEWS,
  AD_SOURCES,
  AD_WORKS
} from './artwork-documentation.tables';
import {
  Answer,
  Answers,
  AssetGateway,
  AssetLink,
  Capabilities,
  ContextAccess,
  ContextRecord,
  DocumentationProfile,
  Issue,
  ModuleId,
  MODULE_IDS,
  Mutation,
  Operation,
  ReviewLane
} from './artwork-documentation.types';
import {
  artistCapabilities,
  canReadField,
  laneForModule,
  mergeCapabilities,
  requireEdit
} from './artwork-documentation.access';
import {
  applyOperations,
  conditionalRequired,
  CONFIRMATION_COPY,
  CONFIRMATION_COPY_VERSION,
  DOCUMENTATION_LIMITS,
  emptyModules,
  FIELD_CATALOGUE,
  getAnswer,
  getProfile,
  PROFILES
} from './artwork-documentation.catalogue';
import {
  answerValue,
  digest,
  fail,
  normalizeJson
} from './artwork-documentation.validation';

export type RevisionRow = {
  id: string;
  context_id: string;
  revision_number: number;
  source_draft_version: number;
  snapshot_json: unknown;
  confirmation_json: unknown;
  sha256: string;
  created_at: number;
};
export type ReviewRow = {
  revision_id: string;
  lane: ReviewLane;
  review_version: number;
  status: string;
  reviewer_profile_id: string | null;
  reason: string | null;
  updated_at: number;
};
type SourceRow = {
  id: string;
  context_id: string;
  drop_id: string;
  receipt_text: string;
  sha256: string;
  is_excerpt: boolean;
};
type DropRow = {
  id: string;
  author_id: string;
  wave_id: string;
  title: string | null;
};
type ArtistRow = {
  owner_profile_id: string;
  record_version: number;
  latest_revision_id: string | null;
};
type ModuleAssetReference = { field: string; id: string; role?: string };
function moduleAssetReferences(
  moduleId: ModuleId,
  answers: Answers
): ModuleAssetReference[] {
  const result: ModuleAssetReference[] = [];
  const add = (field: string, role?: string) => {
    const id = answerValue<string>(answers[field]);
    if (id) result.push({ field, id, role });
  };
  if (moduleId === 'artwork') add('canonical_asset_id', 'artwork_final');
  if (moduleId === 'rights')
    for (const id of answerValue<string[]>(answers.consent_asset_ids) ?? [])
      result.push({
        field: 'consent_asset_ids',
        id,
        role: 'consent_instrument'
      });
  if (moduleId === 'interview') {
    add('recording_asset_id', 'interview_recording');
    add('transcript_asset_id', 'interview_transcript');
  }
  if (moduleId === 'process')
    for (const entry of answerValue<{ entries: { asset_id?: string }[] }>(
      answers.ingredients
    )?.entries ?? [])
      if (entry.asset_id)
        result.push({ field: 'ingredients', id: entry.asset_id });
  return result;
}
function validateInterview(
  answers: Answers,
  profile: DocumentationProfile
): void {
  const instrument = profile.interview_instrument;
  const suppliedId = answerValue<string>(answers.instrument_id);
  const suppliedVersion = answerValue<number>(answers.instrument_version);
  if (
    (suppliedId !== undefined && suppliedId !== instrument.id) ||
    (suppliedVersion !== undefined && suppliedVersion !== instrument.version)
  )
    fail(422, 'UNSUPPORTED_INTERVIEW_INSTRUMENT');
  for (const kind of ['recording', 'transcript']) {
    const asset = answers[`${kind}_asset_id`];
    if (!answerValue(asset)) continue;
    const permission = answerValue<string>(answers[`${kind}_permission`]);
    if (
      !answerValue(answers.date) ||
      !answerValue<unknown[]>(answers.participants)?.length ||
      !['private_review', 'intended_public_record'].includes(permission ?? '')
    )
      fail(422, 'INTERVIEW_PERMISSION_REQUIRED');
    if (
      asset.intended_visibility === 'public_record' &&
      permission !== 'intended_public_record'
    )
      fail(422, 'INTERVIEW_DISCLOSURE_MISMATCH');
  }
}
export function confirmationStatus(
  draftVersion: number,
  confirmedDraftVersion?: number
): string {
  if (confirmedDraftVersion === undefined) return 'unconfirmed';
  return confirmedDraftVersion === draftVersion ? 'current' : 'newer_draft';
}
function moduleCompletion(missing: number, answered: number): string {
  if (missing) return answered ? 'in_progress' : 'not_started';
  return answered ? 'ready' : 'not_applicable';
}
function validateSourceActor(
  drop: DropRow | null,
  actor: string,
  profile: DocumentationProfile,
  coordinator: boolean
): void {
  if (drop && profile.wave_id && drop.wave_id !== profile.wave_id)
    fail(422, 'SOURCE_WAVE_MISMATCH');
  if (drop && drop.author_id !== actor && !coordinator)
    fail(404, 'UNAVAILABLE');
  if (coordinator && !drop) fail(422, 'VERIFIED_SOURCE_REQUIRED');
}
const noAssetGateway: AssetGateway = {
  listAssets: async () => [],
  validateReadyAsset: async () => fail(409, 'ASSET_NOT_READY'),
  markReferenced: async () => undefined
};
export type DocumentationFeaturePolicy = {
  enabled(): boolean;
  selfServiceEnabled(): boolean;
};
const environmentFeaturePolicy: DocumentationFeaturePolicy = {
  enabled: () => process.env.ARTWORK_DOCUMENTATION_ENABLED === 'true',
  selfServiceEnabled: () =>
    process.env.ARTWORK_DOCUMENTATION_SELF_SERVICE_ENABLED === 'true'
};

export class ArtworkDocumentationService {
  constructor(
    readonly db: ArtworkDocumentationDb = artworkDocumentationDb,
    private assets: AssetGateway = noAssetGateway,
    private readonly featurePolicy: DocumentationFeaturePolicy = environmentFeaturePolicy
  ) {}
  setAssetGateway(gateway: AssetGateway): void {
    this.assets = gateway;
  }
  actor(ctx: RequestContext): string {
    if (!this.featurePolicy.enabled()) fail(404, 'UNAVAILABLE');
    const actor = ctx.authenticationContext?.authenticatedProfileId;
    if (!actor) fail(401, 'AUTHENTICATION_REQUIRED');
    return actor;
  }
  async bindAssetMutation(
    id: string,
    uploadId: string,
    mutation: Mutation,
    ctx: RequestContext
  ): Promise<void> {
    const actor = this.actor(ctx);
    await this.authorizeContext(id, ctx);
    await this.db.idempotent(
      digest([actor, mutation.route, mutation.key]),
      digest(mutation.body),
      ctx,
      async () => ({ context_id: id, upload_id: uploadId })
    );
  }
  async authorizeContext(
    id: string,
    ctx: RequestContext,
    lock = false
  ): Promise<ContextAccess> {
    const actorProfileId = this.actor(ctx);
    const context = await this.db.context(id, ctx, lock);
    if (!context) fail(404, 'UNAVAILABLE');
    const isArtist =
      context.owner_profile_id === actorProfileId &&
      !ctx.authenticationContext?.isAuthenticatedAsProxy();
    const capabilities = isArtist
      ? artistCapabilities()
      : await this.grantCapabilities(
          actorProfileId,
          context.id,
          context.program_id,
          ctx
        );
    if (!capabilities.read_context) fail(404, 'UNAVAILABLE');
    return { context, capabilities, isArtist, actorProfileId };
  }
  async grantCapabilities(
    actor: string,
    contextId: string | null,
    programId: string | null,
    ctx: RequestContext
  ): Promise<Capabilities> {
    const rows = await this.db.query<{ capabilities_json: unknown }>(
      `SELECT capabilities_json FROM ${AD_GRANTS} WHERE subject_profile_id=:actor AND revoked_at IS NULL AND ((context_id=:contextId AND context_id IS NOT NULL) OR (program_id=:programId AND context_id IS NULL AND program_id IS NOT NULL))`,
      { actor, contextId, programId },
      ctx
    );
    return mergeCapabilities(
      rows.map((row) => parseJson<Partial<Capabilities>>(row.capabilities_json))
    );
  }
  async profiles(ctx: RequestContext) {
    if (!this.featurePolicy.enabled())
      return { enabled: false, self_service_enabled: false, profiles: [] };
    this.actor(ctx);
    return {
      enabled: true,
      self_service_enabled: this.featurePolicy.selfServiceEnabled(),
      profiles: PROFILES
    };
  }
  async audit(
    access: ContextAccess,
    kind: string,
    references: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.insert(
      AD_EVENTS,
      {
        id: randomUUID(),
        context_id: access.context.id,
        actor_profile_id: access.actorProfileId,
        kind,
        references_json: JSON.stringify(references),
        created_at: Date.now()
      },
      ctx
    );
  }
  async mutate<T extends Record<string, unknown>>(
    id: string,
    mutation: Mutation,
    ctx: RequestContext,
    run: (access: ContextAccess, transaction: RequestContext) => Promise<T>,
    content = true
  ): Promise<T> {
    const actor = this.actor(ctx);
    await this.authorizeContext(id, ctx);
    return this.db.idempotent(
      digest([actor, mutation.route, mutation.key]),
      digest(mutation.body),
      ctx,
      async (transaction) => {
        const access = await this.authorizeContext(id, transaction, true);
        if (
          content &&
          mutation.expectedVersion !== access.context.draft_version
        )
          fail(409, 'DRAFT_CONFLICT');
        const result = await run(access, transaction);
        if (content) {
          if (
            Buffer.byteLength(JSON.stringify(access.context.modules), 'utf8') >
            DOCUMENTATION_LIMITS.context_payload_bytes
          )
            fail(413, 'CONTEXT_PAYLOAD_LIMIT');
          access.context.draft_version++;
          access.context.updated_at = Date.now();
          await this.db.saveContext(access.context, transaction);
          await this.audit(
            access,
            mutation.route,
            { draft_version: access.context.draft_version },
            transaction
          );
        }
        return result;
      }
    );
  }
  async getContext(id: string, ctx: RequestContext) {
    const access = await this.authorizeContext(id, ctx);
    const context = access.context;
    const [artist, latest, assets, sourceLinks, reviews] = await Promise.all([
      this.db.one<ArtistRow>(
        `SELECT * FROM ${AD_ARTISTS} WHERE owner_profile_id=:owner`,
        { owner: context.owner_profile_id },
        ctx
      ),
      context.latest_revision_id
        ? this.db.one<RevisionRow>(
            `SELECT * FROM ${AD_REVISIONS} WHERE id=:id AND context_id=:contextId`,
            { id: context.latest_revision_id, contextId: id },
            ctx
          )
        : null,
      this.assets.listAssets(id, access, ctx),
      this.db.query<Record<string, unknown>>(
        `SELECT * FROM ${AD_DROP_LINKS} WHERE context_id=:id`,
        { id },
        ctx
      ),
      context.latest_revision_id
        ? this.reviews(context.latest_revision_id, access, ctx)
        : []
    ]);
    const availableArtist =
      access.isArtist && artist?.latest_revision_id
        ? await this.db.one<{
            id: string;
            record_version: number;
            answers_json: unknown;
          }>(
            `SELECT id,record_version,answers_json FROM ${AD_ARTIST_REVISIONS} WHERE id=:revisionId AND owner_profile_id=:owner`,
            {
              revisionId: artist.latest_revision_id,
              owner: context.owner_profile_id
            },
            ctx
          )
        : null;
    return {
      id,
      work_id: context.work_id,
      owner_profile_id: context.owner_profile_id,
      program_id: context.program_id,
      profile: this.projectProfile(context.profile, access),
      draft_version: context.draft_version,
      artist_record_version: artist?.record_version ?? 0,
      artist_record_revision_id: context.artist_record_revision_id,
      modules: this.projectModules(context, access),
      capabilities: access.capabilities,
      available_artist_record: availableArtist
        ? {
            id: availableArtist.id,
            record_version: availableArtist.record_version,
            answers: parseJson<Answers>(availableArtist.answers_json)
          }
        : null,
      confirmation_status: confirmationStatus(
        context.draft_version,
        latest?.source_draft_version
      ),
      latest_revision_id: context.latest_revision_id,
      lifecycle: context.lifecycle,
      assets,
      asset_links: this.projectAssetLinks(context, access),
      reviews,
      source_links: sourceLinks,
      issues: this.issues(context).filter((issue) =>
        canReadField(
          access,
          issue.field,
          getAnswer(context.modules, issue.field)?.intended_visibility ===
            'restricted'
        )
      ),
      updated_at: context.updated_at
    };
  }
  async publicPreview(id: string, ctx: RequestContext) {
    const access = await this.authorizeContext(id, ctx);
    const ordinary: ContextAccess = {
      ...access,
      isArtist: false,
      capabilities: { ...mergeCapabilities([]), read_context: true }
    };
    const projected = this.projectModules(access.context, ordinary);
    const modules = Object.fromEntries(
      MODULE_IDS.map((moduleId) => [
        moduleId,
        {
          schema_version: 1,
          answers: Object.fromEntries(
            Object.entries(projected[moduleId].answers).filter(
              ([, answer]) =>
                !('redacted' in answer) &&
                answer.intended_visibility === 'public_record'
            )
          )
        }
      ])
    );
    return {
      context_id: id,
      draft_version: access.context.draft_version,
      modules,
      asset_links: this.projectAssetLinks(access.context, ordinary)
    };
  }
  async createContextForWork(
    workId: string,
    body: {
      profile_id: string;
      profile_version: number;
      program_id?: string;
      acknowledge_empty_context: boolean;
    },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    const actor = this.actor(ctx);
    if (
      ctx.authenticationContext?.isAuthenticatedAsProxy() ||
      body.acknowledge_empty_context !== true
    )
      fail(403, 'DIRECT_ARTIST_REQUIRED');
    const profile = getProfile(body.profile_id, body.profile_version);
    if ((body.program_id ?? null) !== profile.program_id)
      fail(422, 'INVALID_PROGRAM');
    const reference = await this.db.idempotent(
      digest([actor, mutation.route, mutation.key]),
      digest(body),
      ctx,
      async (transaction) => {
        const work = await this.db.one<{ owner_profile_id: string }>(
          `SELECT owner_profile_id FROM ${AD_WORKS} WHERE id=:id FOR UPDATE`,
          { id: workId },
          transaction
        );
        if (work?.owner_profile_id !== actor) fail(404, 'UNAVAILABLE');
        if (profile.program_id) {
          const caps = await this.grantCapabilities(
            actor,
            null,
            profile.program_id,
            transaction
          );
          if (!caps.read_context) fail(403, 'PROGRAM_INVITATION_REQUIRED');
        } else if (!this.featurePolicy.selfServiceEnabled())
          fail(403, 'SELF_SERVICE_DISABLED');
        const context: ContextRecord = {
          id: randomUUID(),
          work_id: workId,
          owner_profile_id: actor,
          program_id: profile.program_id,
          profile,
          draft_version: 1,
          artist_record_revision_id: null,
          latest_revision_id: null,
          lifecycle: 'active',
          modules: emptyModules(),
          asset_links: [],
          restricted_paths: [],
          created_at: Date.now(),
          updated_at: Date.now()
        };
        await this.db.insert(
          AD_CONTEXTS,
          {
            id: context.id,
            work_id: workId,
            owner_profile_id: actor,
            program_id: profile.program_id,
            profile_json: JSON.stringify(profile),
            draft_version: 1,
            artist_record_revision_id: null,
            latest_revision_id: null,
            lifecycle: 'active',
            modules_json: JSON.stringify(context.modules),
            asset_links_json: '[]',
            restricted_paths_json: '[]',
            created_at: context.created_at,
            updated_at: context.updated_at
          },
          transaction
        );
        await this.audit(
          {
            context,
            actorProfileId: actor,
            capabilities: artistCapabilities(),
            isArtist: true
          },
          'empty_work_context_created',
          { work_id: workId },
          transaction
        );
        return { context_id: context.id };
      }
    );
    return this.getContext(reference.context_id, ctx);
  }
  private projectProfile(
    profile: DocumentationProfile,
    access: ContextAccess
  ): DocumentationProfile {
    if (access.isArtist) return profile;
    return {
      ...profile,
      required_for_review: profile.required_for_review.filter((path) =>
        canReadField(access, path)
      ),
      modules: profile.modules.map((module) => ({
        ...module,
        fields: module.fields.map((field) =>
          canReadField(access, `${module.id}.${field.id}`)
            ? field
            : {
                ...field,
                value_schema: {
                  type: 'object' as const,
                  description: 'Restricted question'
                },
                allowed_statuses: []
              }
        )
      }))
    };
  }
  projectModules(context: ContextRecord, access: ContextAccess) {
    const required = [
      ...context.profile.required_for_review,
      ...conditionalRequired(context.modules)
    ];
    return Object.fromEntries(
      MODULE_IDS.map((moduleId) => {
        const answers: Record<string, Answer | { redacted: true }> = {};
        for (const definition of FIELD_CATALOGUE[moduleId]) {
          const answer = context.modules[moduleId][definition.id];
          if (
            !canReadField(
              access,
              `${moduleId}.${definition.id}`,
              answer?.intended_visibility === 'restricted'
            ) ||
            moduleAssetReferences(moduleId, context.modules[moduleId])
              .filter((reference) => reference.field === definition.id)
              .some(
                (reference) =>
                  !context.asset_links.some(
                    (link) =>
                      link.asset_id === reference.id &&
                      this.canReadAssetLink(link, access)
                  )
              )
          )
            answers[definition.id] = { redacted: true };
          else if (answer) answers[definition.id] = answer;
        }
        const visibleRequired = required.filter(
          (path) =>
            path.startsWith(`${moduleId}.`) &&
            !('redacted' in (answers[path.split('.')[1]] ?? {})) &&
            canReadField(
              access,
              path,
              getAnswer(context.modules, path)?.intended_visibility ===
                'restricted'
            )
        );
        const missing = visibleRequired.filter(
          (path) => !getAnswer(context.modules, path)
        );
        const addressed = visibleRequired.length - missing.length;
        const count = Object.values(answers).filter(
          (answer) => !('redacted' in answer)
        ).length;
        return [
          moduleId,
          {
            schema_version: 1,
            answers,
            completeness: {
              status: moduleCompletion(missing.length, count),
              required: visibleRequired.length,
              addressed,
              missing,
              restricted_checks_exist: !access.isArtist
            }
          }
        ];
      })
    );
  }
  projectAssetLinks(
    context: ContextRecord,
    access: ContextAccess
  ): AssetLink[] {
    const visible = context.asset_links.filter((link) =>
      this.canReadAssetLink(link, access)
    );
    const visibleIds = new Set(visible.map((link) => link.asset_id));
    return visible.map((link) => ({
      ...link,
      derived_from_asset_ids: link.derived_from_asset_ids.filter((id) =>
        visibleIds.has(id)
      ),
      manifest:
        access.isArtist ||
        access.capabilities.read_archival_files ||
        (['consent_instrument', 'rights_instrument'].includes(link.role) &&
          access.capabilities.read_rights_evidence)
          ? link.manifest
          : { ...link.manifest, sha256: null }
    }));
  }
  canReadAssetLink(link: AssetLink, access: ContextAccess): boolean {
    if (access.isArtist) return true;
    if (
      ['consent_instrument', 'rights_instrument'].includes(link.role) ||
      access.context.restricted_paths.includes(`asset-rights:${link.asset_id}`)
    )
      return access.capabilities.read_rights_evidence;
    return (
      (link.intended_visibility !== 'restricted' &&
        !access.context.restricted_paths.includes(`asset:${link.asset_id}`)) ||
      access.capabilities.read_archival_files
    );
  }
  async createWork(
    body: {
      profile_id: string;
      profile_version: number;
      program_id?: string;
      source_drop_id?: string;
      start_mode: string;
    },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    const actor = this.actor(ctx);
    if (ctx.authenticationContext?.isAuthenticatedAsProxy())
      fail(403, 'DIRECT_ARTIST_REQUIRED');
    const profile = getProfile(body.profile_id, body.profile_version);
    if ((body.program_id ?? null) !== profile.program_id)
      fail(422, 'INVALID_PROGRAM');
    const reference = await this.db.idempotent(
      digest([actor, mutation.route, mutation.key]),
      digest(body),
      ctx,
      async (transaction) => {
        const drop = body.source_drop_id
          ? await this.getDrop(body.source_drop_id, transaction, true)
          : null;
        const caps = await this.grantCapabilities(
          actor,
          null,
          profile.program_id,
          transaction
        );
        const coordinator =
          body.start_mode === 'coordinator_import' && caps.manage_assignments;
        validateSourceActor(drop, actor, profile, coordinator);
        const existing = await this.existingSourceContext(
          drop,
          profile,
          transaction
        );
        if (existing) return { context_id: existing };
        if (profile.program_id && !caps.manage_context && !coordinator)
          fail(403, 'PROGRAM_INVITATION_REQUIRED');
        if (!profile.program_id && !this.featurePolicy.selfServiceEnabled())
          fail(403, 'SELF_SERVICE_DISABLED');
        const owner = coordinator ? drop!.author_id : actor;
        const context: ContextRecord = {
          id: randomUUID(),
          work_id: randomUUID(),
          owner_profile_id: owner,
          program_id: profile.program_id,
          profile,
          draft_version: 1,
          artist_record_revision_id: null,
          latest_revision_id: null,
          lifecycle: 'active',
          modules: emptyModules(),
          asset_links: [],
          restricted_paths: [],
          created_at: Date.now(),
          updated_at: Date.now()
        };
        await this.db.insert(
          AD_WORKS,
          {
            id: context.work_id,
            owner_profile_id: owner,
            creator_profile_id: actor,
            created_at: context.created_at,
            updated_at: context.updated_at
          },
          transaction
        );
        await this.db.insert(
          AD_CONTEXTS,
          {
            id: context.id,
            work_id: context.work_id,
            owner_profile_id: owner,
            program_id: context.program_id,
            profile_json: JSON.stringify(profile),
            draft_version: 1,
            artist_record_revision_id: null,
            latest_revision_id: null,
            lifecycle: 'active',
            modules_json: JSON.stringify(context.modules),
            asset_links_json: '[]',
            restricted_paths_json: '[]',
            created_at: context.created_at,
            updated_at: context.updated_at
          },
          transaction
        );
        const access = {
          context,
          actorProfileId: actor,
          capabilities: coordinator ? caps : artistCapabilities(),
          isArtist: !coordinator
        };
        if (drop) await this.addSource(access, drop, transaction);
        await this.audit(
          access,
          'context_created',
          { work_id: context.work_id },
          transaction
        );
        return { context_id: context.id };
      }
    );
    return this.getContext(reference.context_id, ctx);
  }
  private async existingSourceContext(
    drop: DropRow | null,
    profile: DocumentationProfile,
    ctx: RequestContext
  ): Promise<string | null> {
    if (!drop) return null;
    const existing = await this.db.one<{ context_id: string }>(
      `SELECT context_id FROM ${AD_DROP_LINKS} WHERE drop_id=:id`,
      { id: drop.id },
      ctx
    );
    if (!existing) return null;
    const linked = await this.authorizeContext(existing.context_id, ctx);
    if (
      linked.context.program_id !== profile.program_id ||
      linked.context.profile.profile_id !== profile.profile_id
    )
      fail(409, 'SOURCE_CONTEXT_PROFILE_MISMATCH');
    return existing.context_id;
  }
  async getDrop(
    id: string,
    ctx: RequestContext,
    lock = false
  ): Promise<DropRow> {
    const drop = await this.db.one<DropRow>(
      `SELECT id,author_id,wave_id,title FROM ${DROPS_TABLE} WHERE id=:id${lock ? ' FOR UPDATE' : ''}`,
      { id },
      ctx
    );
    if (!drop) fail(404, 'UNAVAILABLE');
    return drop;
  }
  async addSource(
    access: ContextAccess,
    drop: DropRow,
    ctx: RequestContext
  ): Promise<void> {
    const id = access.context.id;
    if (
      drop.author_id !== access.context.owner_profile_id ||
      (access.context.profile.wave_id &&
        drop.wave_id !== access.context.profile.wave_id)
    )
      fail(422, 'SOURCE_MISMATCH');
    const existing = await this.db.one<{ context_id: string }>(
      `SELECT context_id FROM ${AD_DROP_LINKS} WHERE drop_id=:id FOR UPDATE`,
      { id: drop.id },
      ctx
    );
    if (existing) {
      if (existing.context_id !== id) fail(409, 'SOURCE_ALREADY_LINKED');
      return;
    }
    const count = await this.db.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${AD_SOURCES} WHERE context_id=:id`,
      { id },
      ctx
    );
    if ((count?.count ?? 0) >= 30) fail(413, 'SOURCE_LIMIT');
    const [parts, metadata] = await Promise.all([
      this.db.query<{ content: string }>(
        `SELECT content FROM ${DROPS_PARTS_TABLE} WHERE drop_id=:id ORDER BY drop_part_id ASC`,
        { id: drop.id },
        ctx
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT data_key,data_value FROM ${DROP_METADATA_TABLE} WHERE drop_id=:id`,
        { id: drop.id },
        ctx
      )
    ]);
    const fullText = JSON.stringify({
      drop_id: drop.id,
      title: drop.title,
      parts,
      metadata
    });
    const bytes = Buffer.from(fullText, 'utf8');
    const isExcerpt = bytes.byteLength > 262144;
    // Slice code points, not UTF-8 sequences; an excerpt is never parsed as a full receipt.
    let receipt = fullText;
    if (isExcerpt) {
      receipt = bytes
        .subarray(0, 262140)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
    }
    const sourceId = randomUUID();
    await this.db.insert(
      AD_SOURCES,
      {
        id: sourceId,
        context_id: id,
        drop_id: drop.id,
        receipt_text: receipt,
        sha256: createHash('sha256').update(receipt, 'utf8').digest('hex'),
        is_excerpt: isExcerpt,
        importer_profile_id: access.actorProfileId,
        created_at: Date.now()
      },
      ctx
    );
    await this.db.insert(
      AD_DROP_LINKS,
      {
        drop_id: drop.id,
        context_id: id,
        work_id: access.context.work_id,
        author_profile_id: drop.author_id,
        wave_id: drop.wave_id,
        source_receipt_id: sourceId
      },
      ctx
    );
  }
  async linkSource(
    id: string,
    dropId: string,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.mutate(id, mutation, ctx, async (access, transaction) => {
      if (!access.isArtist && !access.capabilities.manage_context)
        fail(403, 'SOURCE_LINK_NOT_ALLOWED');
      await this.addSource(
        access,
        await this.getDrop(dropId, transaction, true),
        transaction
      );
      return { context_id: id };
    });
    return this.getContext(id, ctx);
  }
  async patchModule(
    id: string,
    moduleId: ModuleId,
    body: {
      schema_version: number;
      operations: Operation[];
      expected_artist_record_version?: number;
      replacement_reason?: string;
    },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.mutate(id, mutation, ctx, async (access, transaction) => {
      requireEdit(access, moduleId);
      if (body.schema_version !== 1) fail(422, 'UNSUPPORTED_SCHEMA');
      for (const operation of body.operations)
        if (
          !canReadField(
            access,
            `${moduleId}.${operation.field}`,
            access.context.modules[moduleId]?.[operation.field]
              ?.intended_visibility === 'restricted' ||
              operation.answer?.intended_visibility === 'restricted'
          )
        )
          fail(403, 'FIELD_EDIT_NOT_ALLOWED');
      const previous = access.context.modules[moduleId];
      const answers = applyOperations(moduleId, previous, body.operations);
      if (moduleId === 'interview')
        validateInterview(answers, access.context.profile);
      const previousReferences = new Set(
        moduleAssetReferences(moduleId, previous).map(
          (reference) => `${reference.id}:${reference.role ?? ''}`
        )
      );
      for (const reference of moduleAssetReferences(moduleId, answers)) {
        if (previousReferences.has(`${reference.id}:${reference.role ?? ''}`))
          continue;
        if (
          !access.context.asset_links.some(
            (link) =>
              link.asset_id === reference.id &&
              (!reference.role || reference.role === link.role) &&
              this.canReadAssetLink(link, access)
          )
        )
          fail(404, 'UNAVAILABLE');
      }
      if (
        moduleId === 'artwork' &&
        access.context.latest_revision_id &&
        digest(previous.canonical_asset_id ?? null) !==
          digest(answers.canonical_asset_id ?? null) &&
        (!body.replacement_reason ||
          Array.from(body.replacement_reason).length < 20 ||
          Array.from(body.replacement_reason).length > 1000)
      )
        fail(422, 'REPLACEMENT_REASON_REQUIRED');
      access.context.modules[moduleId] = answers;
      for (const [field, answer] of Object.entries(answers))
        if (answer.intended_visibility === 'restricted')
          access.context.restricted_paths.push(`${moduleId}.${field}`);
      access.context.restricted_paths = Array.from(
        new Set(access.context.restricted_paths)
      );
      if (moduleId === 'identity')
        await this.saveArtistRecord(
          access,
          body.expected_artist_record_version,
          transaction
        );
      await this.validateAssetReferences(access, transaction, false);
      return { context_id: id };
    });
    return this.getContext(id, ctx);
  }
  async saveArtistRecord(
    access: ContextAccess,
    expected: number | undefined,
    ctx: RequestContext
  ): Promise<void> {
    const owner = access.context.owner_profile_id;
    await this.db.query(
      `INSERT INTO ${AD_ARTISTS} (owner_profile_id,record_version,latest_revision_id) VALUES (:owner,0,NULL) ON DUPLICATE KEY UPDATE owner_profile_id=owner_profile_id`,
      { owner },
      ctx
    );
    const row = (await this.db.one<ArtistRow>(
      `SELECT * FROM ${AD_ARTISTS} WHERE owner_profile_id=:owner FOR UPDATE`,
      { owner },
      ctx
    ))!;
    if (expected === undefined) fail(428, 'ARTIST_VERSION_REQUIRED');
    if (expected !== row.record_version) fail(409, 'ARTIST_RECORD_CONFLICT');
    const identity = { ...access.context.modules.identity };
    delete identity.private_contact;
    const revisionId = randomUUID();
    await this.db.insert(
      AD_ARTIST_REVISIONS,
      {
        id: revisionId,
        owner_profile_id: owner,
        record_version: row.record_version + 1,
        answers_json: JSON.stringify(identity),
        actor_profile_id: access.actorProfileId,
        created_at: Date.now()
      },
      ctx
    );
    await this.db.query(
      `UPDATE ${AD_ARTISTS} SET record_version=record_version+1,latest_revision_id=:revisionId WHERE owner_profile_id=:owner`,
      { revisionId, owner },
      ctx
    );
    access.context.artist_record_revision_id = revisionId;
  }
  async pinArtist(
    id: string,
    revisionId: string,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.mutate(id, mutation, ctx, async (access, transaction) => {
      if (!access.isArtist) fail(403, 'DIRECT_ARTIST_REQUIRED');
      const revision = await this.db.one<{ answers_json: unknown }>(
        `SELECT answers_json FROM ${AD_ARTIST_REVISIONS} WHERE id=:id AND owner_profile_id=:owner`,
        { id: revisionId, owner: access.context.owner_profile_id },
        transaction
      );
      if (!revision) fail(404, 'UNAVAILABLE');
      const privateContact = access.context.modules.identity.private_contact;
      access.context.modules.identity = parseJson<Answers>(
        revision.answers_json
      );
      if (privateContact)
        access.context.modules.identity.private_contact = privateContact;
      access.context.restricted_paths = Array.from(
        new Set([
          ...access.context.restricted_paths,
          ...Object.entries(access.context.modules.identity)
            .filter(([, answer]) => answer.intended_visibility === 'restricted')
            .map(([field]) => `identity.${field}`)
        ])
      );
      access.context.artist_record_revision_id = revisionId;
      return { context_id: id };
    });
    return this.getContext(id, ctx);
  }
  async validateAssetReferences(
    access: ContextAccess,
    ctx: RequestContext,
    confirmation: boolean
  ): Promise<void> {
    const context = access.context;
    // Permission to change each field/link is checked at its write boundary.
    // Structural validation must also inspect untouched private references without
    // disclosing them to an editor who has access only to ordinary fields.
    const validationAccess = {
      ...access,
      isArtist: true,
      capabilities: artistCapabilities()
    };
    const canonical = answerValue<string>(
      context.modules.artwork.canonical_asset_id
    );
    const references = MODULE_IDS.flatMap((moduleId) =>
      moduleAssetReferences(moduleId, context.modules[moduleId])
    );
    for (const reference of references) {
      if (
        !context.asset_links.some(
          (link) =>
            link.asset_id === reference.id &&
            (!reference.role || link.role === reference.role)
        )
      )
        fail(422, 'ASSET_ROLE_REQUIRED');
      await this.assets.validateReadyAsset(
        context.id,
        reference.id,
        validationAccess,
        ctx
      );
    }
    if (!confirmation) return;
    for (const link of context.asset_links)
      await this.assets.validateReadyAsset(
        context.id,
        link.asset_id,
        validationAccess,
        ctx
      );
    const master = answerValue<{ kind: string }>(
      context.modules.files.master_availability
    )?.kind;
    if (
      master === 'supplied' &&
      !context.asset_links.some((link) => link.role === 'preservation_master')
    )
      fail(422, 'MASTER_ASSET_REQUIRED');
    if (
      master === 'same_as_final' &&
      !context.asset_links.some(
        (link) =>
          link.role === 'preservation_master' && link.asset_id === canonical
      )
    )
      fail(422, 'MASTER_ROLE_REQUIRED');
    if (
      answerValue<{ kind: string }>(context.modules.files.source_availability)
        ?.kind === 'supplied' &&
      !context.asset_links.some((link) =>
        ['camera_original', 'working_file'].includes(link.role)
      )
    )
      fail(422, 'SOURCE_ASSET_REQUIRED');
  }
  issues(context: ContextRecord): Issue[] {
    const result: Issue[] = [];
    const add = (field: string, code: string) =>
      result.push({ field, code, lane: laneForModule(field.split('.')[0]) });
    for (const path of [
      ...context.profile.required_for_review,
      ...conditionalRequired(context.modules)
    ])
      if (!getAnswer(context.modules, path)) add(path, 'ANSWER_REQUIRED');
    if (
      getAnswer(context.modules, 'artwork.capture_date')?.status === 'unknown'
    )
      add('artwork.capture_date', 'CAPTURE_DATE_UNKNOWN');
    if (
      answerValue<{ kind: string }>(context.modules.files.master_availability)
        ?.kind === 'unavailable'
    )
      add('files.master_availability', 'MASTER_UNAVAILABLE');
    if (
      answerValue<{ kind: string }>(context.modules.context.theme_connection)
        ?.kind === 'caption_reference' &&
      !answerValue(context.modules.context.caption)
    )
      add('context.theme_connection', 'CAPTION_REQUIRED');
    if (context.profile.profile_id === 'keys_and_gates_v1')
      this.programIssues(context, add);
    return result;
  }
  private programIssues(
    context: ContextRecord,
    add: (field: string, code: string) => void
  ): void {
    const rights = context.modules.rights;
    if (
      answerValue<{ uri: string }>(rights.intended_license)?.uri !==
      'https://creativecommons.org/publicdomain/zero/1.0/'
    )
      add('rights.intended_license', 'PROGRAM_CC0_REQUIRED');
    if (answerValue(context.modules.artwork.edition_statement) !== '1/1')
      add('artwork.edition_statement', 'EDITION_REVIEW_REQUIRED');
    const people = answerValue<string>(rights.people_depicted);
    if (['includes_minors', 'uncertain'].includes(people ?? ''))
      add('rights.people_depicted', 'DEPICTED_PEOPLE_REVIEW_REQUIRED');
    if (
      people &&
      people !== 'none' &&
      answerValue(rights.consent_status) !== 'documents_supplied'
    )
      add('rights.consent_status', 'WRITTEN_CONSENT_REQUIRED');
    if (answerValue(rights.sensitive_context_note))
      add('rights.sensitive_context_note', 'SENSITIVE_CONTEXT_REVIEW_REQUIRED');
  }
  async confirm(
    id: string,
    body: { accepted: boolean; confirmation_copy_version: string },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    const result = await this.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        if (!access.isArtist || !access.capabilities.confirm_as_artist)
          fail(403, 'DIRECT_ARTIST_REQUIRED');
        if (access.context.lifecycle !== 'active')
          fail(409, 'CONTEXT_ARCHIVED');
        if (mutation.expectedVersion !== access.context.draft_version)
          fail(409, 'DRAFT_CONFLICT');
        if (
          body.accepted !== true ||
          body.confirmation_copy_version !== CONFIRMATION_COPY_VERSION
        )
          fail(422, 'CONFIRMATION_COPY_REQUIRED');
        if (
          this.issues(access.context).some((issue) =>
            ['ANSWER_REQUIRED', 'CAPTION_REQUIRED'].includes(issue.code)
          )
        )
          fail(422, 'REQUIRED_ANSWERS_MISSING');
        await this.validateAssetReferences(access, transaction, true);
        const existing = await this.db.one<RevisionRow>(
          `SELECT * FROM ${AD_REVISIONS} WHERE context_id=:id AND source_draft_version=:version`,
          { id, version: access.context.draft_version },
          transaction
        );
        if (existing) return { revision_id: existing.id };
        const previous = await this.db.one<{ max: number }>(
          `SELECT MAX(revision_number) AS max FROM ${AD_REVISIONS} WHERE context_id=:id`,
          { id },
          transaction
        );
        const sourceRefs = await this.db.query<{ id: string; sha256: string }>(
          `SELECT id,sha256 FROM ${AD_SOURCES} WHERE context_id=:id ORDER BY id ASC`,
          { id },
          transaction
        );
        const snapshot = normalizeJson({
          modules: access.context.modules,
          asset_links: access.context.asset_links,
          profile: access.context.profile,
          artist_record_revision_id: access.context.artist_record_revision_id,
          sources: sourceRefs
        });
        const revisionId = randomUUID();
        const confirmation = {
          actor_profile_id: access.actorProfileId,
          copy_version: CONFIRMATION_COPY_VERSION,
          accepted_copy: CONFIRMATION_COPY,
          confirmed_at: Date.now()
        };
        await this.db.insert(
          AD_REVISIONS,
          {
            id: revisionId,
            context_id: id,
            revision_number: (previous?.max ?? 0) + 1,
            source_draft_version: access.context.draft_version,
            sha256: digest(snapshot),
            snapshot_json: JSON.stringify(snapshot),
            confirmation_json: JSON.stringify(confirmation),
            created_at: confirmation.confirmed_at
          },
          transaction
        );
        for (const lane of access.context.profile.review_lanes)
          await this.db.insert(
            AD_REVIEWS,
            {
              revision_id: revisionId,
              lane,
              review_version: 1,
              status: 'pending',
              reviewer_profile_id: null,
              reason: null,
              updated_at: Date.now()
            },
            transaction
          );
        await this.assets.markReferenced(
          id,
          access.context.asset_links.map((link) => link.asset_id),
          transaction
        );
        access.context.latest_revision_id = revisionId;
        await this.db.saveContext(access.context, transaction);
        await this.audit(
          access,
          'documentation_confirmed',
          {
            revision_id: revisionId,
            draft_version: access.context.draft_version
          },
          transaction
        );
        return { revision_id: revisionId };
      },
      false
    );
    return this.getRevision(id, result.revision_id, ctx);
  }
  async revisionRow(
    id: string,
    revisionId: string,
    ctx: RequestContext
  ): Promise<RevisionRow> {
    const revision = await this.db.one<RevisionRow>(
      `SELECT * FROM ${AD_REVISIONS} WHERE context_id=:id AND id=:revisionId`,
      { id, revisionId },
      ctx
    );
    if (!revision) fail(404, 'UNAVAILABLE');
    return revision;
  }
  async getRevision(id: string, revisionId: string, ctx: RequestContext) {
    const access = await this.authorizeContext(id, ctx);
    const revision = await this.revisionRow(id, revisionId, ctx);
    const snapshot = parseJson<
      Pick<
        ContextRecord,
        'modules' | 'asset_links' | 'profile' | 'artist_record_revision_id'
      >
    >(revision.snapshot_json);
    const historical = { ...access.context, ...snapshot };
    return {
      id: revision.id,
      context_id: id,
      revision_number: revision.revision_number,
      source_draft_version: revision.source_draft_version,
      sha256: revision.sha256,
      hash_algorithm: 'sha256',
      canonicalization: 'artwork-documentation-jcs-nfc-lf-v1',
      created_at: revision.created_at,
      snapshot: {
        modules: this.projectModules(historical, access),
        asset_links: this.projectAssetLinks(historical, access),
        profile: this.projectProfile(snapshot.profile, access),
        artist_record_revision_id: snapshot.artist_record_revision_id
      },
      confirmation: parseJson(revision.confirmation_json),
      reviews: await this.reviews(revisionId, access, ctx)
    };
  }
  async reviews(
    revisionId: string,
    access: ContextAccess,
    ctx: RequestContext
  ): Promise<ReviewRow[]> {
    const rows = await this.db.query<ReviewRow>(
      `SELECT revision_id,lane,review_version,status,reviewer_profile_id,reason,updated_at FROM ${AD_REVIEWS} WHERE revision_id=:id ORDER BY lane ASC`,
      { id: revisionId },
      ctx
    );
    return rows.map((row) =>
      row.lane === 'rights' && !access.capabilities.read_rights_evidence
        ? { ...row, reason: null }
        : row
    );
  }
  async sourcePreview(id: string, receiptId: string, ctx: RequestContext) {
    const access = await this.authorizeContext(id, ctx);
    if (!access.capabilities.read_source_receipts)
      fail(403, 'SOURCE_RECEIPT_ACCESS_REQUIRED');
    const source = await this.db.one<SourceRow>(
      `SELECT * FROM ${AD_SOURCES} WHERE id=:receiptId AND context_id=:id`,
      { receiptId, id },
      ctx
    );
    if (!source) fail(404, 'UNAVAILABLE');
    const fields: {
      source_path: string;
      target_field: string;
      answer: Answer;
      will_overwrite: boolean;
    }[] = [];
    if (!source.is_excerpt) {
      const receipt = JSON.parse(source.receipt_text) as {
        title: string | null;
        parts: { content: string }[];
        metadata: { data_key: string; data_value: string }[];
      };
      if (receipt.title && Array.from(receipt.title).length <= 255)
        fields.push({
          source_path: 'title',
          target_field: 'artwork.title',
          answer: {
            status: 'provided',
            value: receipt.title,
            intended_visibility: 'public_record'
          },
          will_overwrite: !!access.context.modules.artwork.title
        });
      const caption = receipt.parts.map((part) => part.content).join('\n\n');
      if (caption && Array.from(caption).length <= 3000)
        fields.push({
          source_path: 'parts',
          target_field: 'context.caption',
          answer: {
            status: 'provided',
            value: {
              primary_language: 'und',
              versions: [
                {
                  language: 'und',
                  text: caption,
                  authorship: 'original',
                  approved_by_artist: false
                }
              ]
            },
            intended_visibility: 'public_record'
          },
          will_overwrite: !!access.context.modules.context.caption
        });
    }
    // Full receipts are separately permissioned; excerpts never infer artist approval.
    return {
      source_receipt_id: receiptId,
      sha256: source.sha256,
      is_excerpt: !!source.is_excerpt,
      receipt_text:
        !access.isArtist &&
        access.context.restricted_paths.some(
          (path) =>
            !path.startsWith('asset:') && !canReadField(access, path, true)
        )
          ? ''
          : source.receipt_text,
      fields: fields.filter((field) =>
        canReadField(
          access,
          field.target_field,
          getAnswer(access.context.modules, field.target_field)
            ?.intended_visibility === 'restricted'
        )
      )
    };
  }
  async importSource(
    id: string,
    body: {
      source_receipt_id: string;
      fields: {
        source_path: string;
        target_field: string;
        overwrite?: boolean;
      }[];
    },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.mutate(id, mutation, ctx, async (access, transaction) => {
      const preview = await this.sourcePreview(
        id,
        body.source_receipt_id,
        transaction
      );
      for (const selected of body.fields) {
        const proposed = preview.fields.find(
          (field) =>
            field.source_path === selected.source_path &&
            field.target_field === selected.target_field
        );
        if (!proposed) fail(422, 'INVALID_SOURCE_MAPPING');
        const [moduleId, field] = proposed.target_field.split('.') as [
          ModuleId,
          string
        ];
        requireEdit(access, moduleId);
        if (
          !canReadField(
            access,
            proposed.target_field,
            getAnswer(access.context.modules, proposed.target_field)
              ?.intended_visibility === 'restricted'
          )
        )
          fail(403, 'FIELD_EDIT_NOT_ALLOWED');
        if (proposed.will_overwrite && selected.overwrite !== true)
          fail(409, 'IMPORT_OVERWRITE_CONFIRMATION_REQUIRED');
        access.context.modules[moduleId] = applyOperations(
          moduleId,
          access.context.modules[moduleId],
          [{ op: 'set', field, answer: proposed.answer }]
        );
      }
      await this.audit(
        access,
        'source_fields_imported',
        {
          source_receipt_id: body.source_receipt_id,
          fields: body.fields.map((field) => field.target_field)
        },
        transaction
      );
      return { context_id: id };
    });
    return this.getContext(id, ctx);
  }
}
export const artworkDocumentationService = new ArtworkDocumentationService();
