import { randomUUID } from 'node:crypto';
import { RequestContext } from '@/request.context';
import {
  AD_CONTEXTS,
  AD_GRANTS,
  AD_REVISIONS,
  AD_REVIEWS,
  AD_THREADS
} from './artwork-documentation.tables';
import {
  artworkDocumentationService,
  ArtworkDocumentationService,
  ReviewRow,
  confirmationStatus
} from './artwork-documentation.service';
import {
  Capabilities,
  ContextAccess,
  ContextRecord,
  Mutation,
  ReviewLane,
  REVIEW_LANES
} from './artwork-documentation.types';
import { answerValue, fail } from './artwork-documentation.validation';
import { canReadField, validateGrant } from './artwork-documentation.access';
import { parseJson } from './artwork-documentation.db';
import { FIELD_CATALOGUE, getProfile } from './artwork-documentation.catalogue';

type Comment = {
  id: string;
  actor_profile_id: string;
  text: string;
  created_at: number;
};
type ThreadRow = {
  id: string;
  context_id: string;
  creator_profile_id: string;
  audience: string;
  restricted_class: string;
  field_path: string | null;
  revision_id: string | null;
  thread_version: number;
  resolved: boolean;
  comments_json: unknown;
  created_at: number;
};
type GrantRow = {
  id: string;
  subject_profile_id: string;
  capabilities_json: unknown;
  created_at: number;
  revoked_at: number | null;
};
export type ContextFilters = {
  cursor?: string;
  limit?: number;
  confirmation_status?: string;
  review_lane?: string;
  outstanding_action?: string;
  profile_id?: string;
  profile_version?: number;
};
type QueueFilter = { clauses: string[]; params: Record<string, unknown> };
function addConfirmationFilter(
  raw: ContextFilters,
  { clauses }: QueueFilter
): void {
  if (raw.confirmation_status !== undefined) {
    const choices: Record<string, string> = {
      unconfirmed: 'r.id IS NULL',
      current: 'r.source_draft_version=c.draft_version',
      newer_draft: 'r.source_draft_version<c.draft_version'
    };
    if (!Object.prototype.hasOwnProperty.call(choices, raw.confirmation_status))
      fail(422, 'INVALID_FILTER');
    clauses.push(choices[raw.confirmation_status]);
  }
}
function addReviewFilter(
  raw: ContextFilters,
  { clauses, params }: QueueFilter
): void {
  if (
    raw.review_lane !== undefined &&
    !REVIEW_LANES.includes(raw.review_lane as ReviewLane)
  )
    fail(422, 'INVALID_FILTER');
  if (
    raw.outstanding_action !== undefined &&
    !['artist_confirmation', 'review', 'changes_requested'].includes(
      raw.outstanding_action
    )
  )
    fail(422, 'INVALID_FILTER');
  if (raw.outstanding_action === 'artist_confirmation')
    clauses.push('(r.id IS NULL OR r.source_draft_version<c.draft_version)');
  const reviewClauses = ['v.revision_id=c.latest_revision_id'];
  if (raw.review_lane) {
    reviewClauses.push('v.lane=:reviewLane');
    params.reviewLane = raw.review_lane;
  }
  if (raw.outstanding_action === 'review')
    reviewClauses.push(
      "v.status='pending'",
      'r.source_draft_version=c.draft_version'
    );
  if (raw.outstanding_action === 'changes_requested')
    reviewClauses.push("v.status='changes_requested'");
  if (reviewClauses.length > 1)
    clauses.push(
      `EXISTS (SELECT 1 FROM ${AD_REVIEWS} v WHERE ${reviewClauses.join(' AND ')})`
    );
}
function addProfileFilter(
  raw: ContextFilters,
  { clauses, params }: QueueFilter
): void {
  if (raw.profile_id !== undefined) {
    if (
      typeof raw.profile_id !== 'string' ||
      !raw.profile_id.length ||
      raw.profile_id.length > 100
    )
      fail(422, 'INVALID_FILTER');
    clauses.push(
      "JSON_UNQUOTE(JSON_EXTRACT(c.profile_json,'$.profile_id'))=:profileId"
    );
    params.profileId = raw.profile_id;
  }
  if (raw.profile_version !== undefined) {
    if (!Number.isSafeInteger(raw.profile_version) || raw.profile_version < 1)
      fail(422, 'INVALID_FILTER');
    clauses.push("JSON_EXTRACT(c.profile_json,'$.version')=:profileVersion");
    params.profileVersion = raw.profile_version;
  }
}
function queueFilters(raw: ContextFilters): {
  sql: string;
  params: Record<string, unknown>;
} {
  const filters: QueueFilter = { clauses: [], params: {} };
  addConfirmationFilter(raw, filters);
  addReviewFilter(raw, filters);
  addProfileFilter(raw, filters);
  return {
    sql: filters.clauses.map((clause) => ` AND (${clause})`).join(''),
    params: filters.params
  };
}

export function pageParameters(raw: { cursor?: string; limit?: number }): {
  limit: number;
  cursor: { updated: number; id: string } | null;
} {
  const limit = raw.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail(422, 'INVALID_PAGE');
  if (!raw.cursor) return { limit, cursor: null };
  try {
    const cursor = JSON.parse(
      Buffer.from(raw.cursor, 'base64url').toString('utf8')
    ) as { updated: number; id: string };
    if (
      !Number.isSafeInteger(cursor.updated) ||
      cursor.updated < 0 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length > 100
    )
      fail(422, 'INVALID_PAGE');
    return { limit, cursor };
  } catch {
    return fail(422, 'INVALID_PAGE');
  }
}
export class ArtworkDocumentationReviewService {
  constructor(
    private readonly core: ArtworkDocumentationService = artworkDocumentationService
  ) {}
  async listContexts(
    ctx: RequestContext,
    raw: ContextFilters,
    programId?: string,
    workId?: string
  ) {
    const actor = this.core.actor(ctx);
    // Reuse only within this list read; subsequent requests resolve membership again.
    const viewerPrograms = await this.core.readableViewerPrograms(
      actor,
      ctx,
      programId
    );
    if (programId) {
      const caps = await this.core.grantCapabilities(
        actor,
        null,
        programId,
        ctx,
        true,
        viewerPrograms
      );
      if (!caps.read_context) fail(404, 'UNAVAILABLE');
    }
    const { limit, cursor } = pageParameters(raw);
    const filters = queueFilters(raw);
    const rows = await this.core.db.query<{ id: string; updated_at: number }>(
      `SELECT c.id,c.updated_at FROM ${AD_CONTEXTS} c LEFT JOIN ${AD_REVISIONS} r ON r.id=c.latest_revision_id WHERE (c.owner_profile_id=:actor OR EXISTS (SELECT 1 FROM ${AD_GRANTS} g WHERE g.subject_profile_id=:actor AND g.revoked_at IS NULL AND (g.context_id=c.id OR (g.context_id IS NULL AND g.program_id=c.program_id)))${viewerPrograms.length ? ' OR c.program_id IN (:viewerPrograms)' : ''}) AND (:programId IS NULL OR c.program_id=:programId) AND (:workId IS NULL OR c.work_id=:workId) AND (:cursorId IS NULL OR c.updated_at<:updated OR (c.updated_at=:updated AND c.id<:cursorId))${filters.sql} ORDER BY c.updated_at DESC,c.id DESC LIMIT :limit`,
      {
        actor,
        viewerPrograms,
        ...filters.params,
        programId: programId ?? null,
        workId: workId ?? null,
        cursorId: cursor?.id ?? null,
        updated: cursor?.updated ?? 0,
        limit: limit + 1
      },
      ctx
    );
    const visible = rows.slice(0, limit);
    const data = await Promise.all(
      visible.map(async (row) =>
        this.summary(
          await this.core.authorizeContext(row.id, ctx, false, viewerPrograms),
          ctx
        )
      )
    );
    const last = visible[visible.length - 1];
    return {
      data,
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ updated: Number(last.updated_at), id: last.id })
            ).toString('base64url')
          : null
    };
  }
  private async summary(access: ContextAccess, ctx: RequestContext) {
    const c = access.context;
    const revision = c.latest_revision_id
      ? await this.core.db.one<{ source_draft_version: number }>(
          `SELECT source_draft_version FROM ${AD_REVISIONS} WHERE id=:id`,
          { id: c.latest_revision_id },
          ctx
        )
      : null;
    const title = c.modules.artwork.title;
    return {
      id: c.id,
      work_id: c.work_id,
      program_id: c.program_id,
      title: canReadField(
        access,
        'artwork.title',
        title?.intended_visibility === 'restricted'
      )
        ? (answerValue<string>(title) ?? null)
        : null,
      draft_version: c.draft_version,
      confirmation_status: confirmationStatus(
        c.draft_version,
        revision?.source_draft_version
      ),
      latest_revision_id: c.latest_revision_id,
      lifecycle: c.lifecycle,
      updated_at: c.updated_at,
      profile_id: c.profile.profile_id,
      profile_version: c.profile.version,
      reviews: c.latest_revision_id
        ? (await this.core.reviews(c.latest_revision_id, access, ctx)).map(
            (review) => ({ ...review, reason: null })
          )
        : []
    };
  }
  async work(id: string, ctx: RequestContext) {
    const list = await this.listContexts(ctx, { limit: 100 }, undefined, id);
    if (!list.data.length) fail(404, 'UNAVAILABLE');
    return { id, contexts: list.data };
  }
  async listRevisions(
    id: string,
    ctx: RequestContext,
    raw: { cursor?: string; limit?: number }
  ) {
    await this.core.authorizeContext(id, ctx);
    const { limit, cursor } = pageParameters(raw);
    const rows = await this.core.db.query<{
      id: string;
      revision_number: number;
      source_draft_version: number;
      sha256: string;
      created_at: number;
    }>(
      `SELECT id,revision_number,source_draft_version,sha256,created_at FROM ${AD_REVISIONS} WHERE context_id=:id AND (:cursorId IS NULL OR created_at<:updated OR (created_at=:updated AND id<:cursorId)) ORDER BY created_at DESC,id DESC LIMIT :limit`,
      {
        id,
        cursorId: cursor?.id ?? null,
        updated: cursor?.updated ?? 0,
        limit: limit + 1
      },
      ctx
    );
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    return {
      data,
      next_cursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ updated: Number(last.created_at), id: last.id })
            ).toString('base64url')
          : null
    };
  }
  async lifecycle(
    id: string,
    lifecycle: 'active' | 'archived',
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(id, mutation, ctx, async (access) => {
      if (!access.capabilities.manage_context)
        fail(403, 'MANAGE_CONTEXT_REQUIRED');
      access.context.lifecycle = lifecycle;
      return { context_id: id };
    });
    return this.core.getContext(id, ctx);
  }
  async upgradePreview(
    id: string,
    profileId: string,
    version: number,
    ctx: RequestContext
  ) {
    const access = await this.core.authorizeContext(id, ctx);
    if (!access.capabilities.manage_context)
      fail(403, 'MANAGE_CONTEXT_REQUIRED');
    const proposed = getProfile(profileId, version);
    if (
      access.context.profile.intake_mode === 'publication_only' &&
      proposed.intake_mode !== 'publication_only'
    )
      fail(422, 'PUBLICATION_PROFILE_REQUIRED');
    if (proposed.program_id !== access.context.program_id)
      fail(422, 'PROGRAM_CHANGE_NOT_ALLOWED');
    return {
      current_profile: access.context.profile,
      proposed_profile: proposed,
      added_required_fields: proposed.required_for_review.filter(
        (field) => !access.context.profile.required_for_review.includes(field)
      ),
      removed_required_fields:
        access.context.profile.required_for_review.filter(
          (field) => !proposed.required_for_review.includes(field)
        )
    };
  }
  async upgrade(
    id: string,
    profileId: string,
    version: number,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(id, mutation, ctx, async (access, transaction) => {
      if (access.context.program_id && access.isArtist)
        fail(403, 'COORDINATOR_REQUIRED');
      const preview = await this.upgradePreview(
        id,
        profileId,
        version,
        transaction
      );
      access.context.profile = preview.proposed_profile;
      await this.core.validatePublicationUpgrade(access.context, transaction);
      return { context_id: id };
    });
    return this.core.getContext(id, ctx);
  }
  async listGrants(id: string, ctx: RequestContext) {
    const access = await this.core.authorizeContext(id, ctx);
    if (!access.capabilities.manage_assignments)
      fail(403, 'ASSIGNMENT_ACCESS_REQUIRED');
    const rows = await this.core.db.query<GrantRow>(
      `SELECT id,subject_profile_id,capabilities_json,created_at,revoked_at FROM ${AD_GRANTS} WHERE context_id=:id ORDER BY created_at ASC`,
      { id },
      ctx
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        subject_profile_id: row.subject_profile_id,
        capabilities: parseJson<Capabilities>(row.capabilities_json),
        created_at: row.created_at,
        revoked_at: row.revoked_at
      }))
    };
  }
  async grant(
    id: string,
    subject: string,
    capabilities: unknown,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        if (
          !access.capabilities.manage_assignments ||
          subject === access.actorProfileId ||
          subject === access.context.owner_profile_id
        )
          fail(403, 'GRANT_NOT_ALLOWED');
        const valid = validateGrant(capabilities, access);
        const grantId = randomUUID();
        await this.core.db.insert(
          AD_GRANTS,
          {
            id: grantId,
            context_id: id,
            program_id: null,
            subject_profile_id: subject,
            capabilities_json: JSON.stringify(valid),
            grantor_profile_id: access.actorProfileId,
            revoked_at: null,
            created_at: Date.now()
          },
          transaction
        );
        await this.core.audit(
          access,
          'access_granted',
          { grant_id: grantId, subject_profile_id: subject },
          transaction
        );
        return { context_id: id };
      },
      false
    );
    return this.listGrants(id, ctx);
  }
  async revoke(
    id: string,
    grantId: string,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        if (!access.capabilities.manage_assignments)
          fail(403, 'GRANT_NOT_ALLOWED');
        const grant = await this.core.db.one<GrantRow>(
          `SELECT * FROM ${AD_GRANTS} WHERE id=:grantId AND context_id=:id`,
          { id, grantId },
          transaction
        );
        if (!grant) fail(404, 'UNAVAILABLE');
        const caps = parseJson<Capabilities>(grant.capabilities_json);
        if (
          access.isArtist &&
          (caps.review_lanes.length ||
            caps.manage_context ||
            caps.manage_assignments)
        )
          fail(403, 'COORDINATOR_REQUIRED');
        await this.core.db.query(
          `UPDATE ${AD_GRANTS} SET revoked_at=:now WHERE id=:grantId`,
          { grantId, now: Date.now() },
          transaction
        );
        await this.core.audit(
          access,
          'access_revoked',
          { grant_id: grantId },
          transaction
        );
        return { context_id: id };
      },
      false
    );
    return this.listGrants(id, ctx);
  }
  canReadThread(thread: ThreadRow, access: ContextAccess): boolean {
    if (
      thread.audience === 'reviewers_only' &&
      !access.capabilities.review_lanes.length &&
      !(access.capabilities.manage_context && !access.isArtist)
    )
      return false;
    if (
      thread.field_path &&
      !canReadField(
        access,
        thread.field_path,
        !!access.context.modules[
          thread.field_path.split('.')[0] as keyof typeof access.context.modules
        ]?.[thread.field_path.split('.')[1]] &&
          access.context.modules[
            thread.field_path.split(
              '.'
            )[0] as keyof typeof access.context.modules
          ][thread.field_path.split('.')[1]].intended_visibility ===
            'restricted'
      )
    )
      return false;
    if (access.isArtist) return true;
    return (
      thread.restricted_class === 'ordinary' ||
      (thread.restricted_class === 'rights' &&
        access.capabilities.read_rights_evidence) ||
      (thread.restricted_class === 'archival' &&
        access.capabilities.read_archival_files) ||
      (thread.restricted_class === 'contact' &&
        access.capabilities.read_contact)
    );
  }
  private projectThread(row: ThreadRow) {
    const { comments_json, creator_profile_id: _creator, ...rest } = row;
    return {
      ...rest,
      resolved: !!row.resolved,
      comments: parseJson<Comment[]>(comments_json)
    };
  }
  async listThreads(id: string, ctx: RequestContext) {
    const access = await this.core.authorizeContext(id, ctx);
    const rows = await this.core.db.query<ThreadRow>(
      `SELECT * FROM ${AD_THREADS} WHERE context_id=:id ORDER BY created_at ASC LIMIT 200`,
      { id },
      ctx
    );
    return {
      data: rows
        .filter((row) => this.canReadThread(row, access))
        .map((row) => this.projectThread(row))
    };
  }
  async thread(
    id: string,
    threadId: string,
    ctx: RequestContext,
    access?: ContextAccess
  ) {
    access ??= await this.core.authorizeContext(id, ctx);
    const row = await this.core.db.one<ThreadRow>(
      `SELECT * FROM ${AD_THREADS} WHERE context_id=:id AND id=:threadId`,
      { id, threadId },
      ctx
    );
    if (!row || !this.canReadThread(row, access)) fail(404, 'UNAVAILABLE');
    return row;
  }
  async createThread(
    id: string,
    body: {
      field_path?: string;
      revision_id?: string;
      audience: string;
      restricted_class: string;
      text: string;
    },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    const result = await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        const row: ThreadRow = {
          id: randomUUID(),
          context_id: id,
          creator_profile_id: access.actorProfileId,
          audience: body.audience,
          restricted_class: body.restricted_class,
          field_path: body.field_path ?? null,
          revision_id: body.revision_id ?? null,
          thread_version: 1,
          resolved: false,
          comments_json: JSON.stringify([
            {
              id: randomUUID(),
              actor_profile_id: access.actorProfileId,
              text: body.text,
              created_at: Date.now()
            }
          ]),
          created_at: Date.now()
        };
        if (body.field_path) {
          const [moduleId, field] = body.field_path.split('.');
          if (
            !FIELD_CATALOGUE[moduleId as keyof typeof FIELD_CATALOGUE]?.some(
              (item) => item.id === field
            )
          )
            fail(422, 'INVALID_FIELD');
        }
        if (!this.canReadThread(row, access))
          fail(403, 'THREAD_AUDIENCE_NOT_ALLOWED');
        if (body.revision_id)
          await this.core.revisionRow(id, body.revision_id, transaction);
        const count = await this.core.db.one<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${AD_THREADS} WHERE context_id=:id`,
          { id },
          transaction
        );
        if ((count?.count ?? 0) >= 200) fail(413, 'THREAD_LIMIT');
        await this.core.db.insert(
          AD_THREADS,
          row as unknown as Record<string, unknown>,
          transaction
        );
        await this.core.audit(
          access,
          'thread_created',
          { thread_id: row.id },
          transaction
        );
        return { thread_id: row.id };
      },
      false
    );
    return this.projectThread(await this.thread(id, result.thread_id, ctx));
  }
  async comment(
    id: string,
    threadId: string,
    text: string,
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        const row = await this.thread(id, threadId, transaction, access);
        const comments = parseJson<Comment[]>(row.comments_json);
        if (comments.length >= 200) fail(413, 'COMMENT_LIMIT');
        comments.push({
          id: randomUUID(),
          actor_profile_id: access.actorProfileId,
          text,
          created_at: Date.now()
        });
        await this.core.db.query(
          `UPDATE ${AD_THREADS} SET comments_json=:comments,thread_version=thread_version+1 WHERE id=:threadId AND context_id=:id`,
          { id, threadId, comments: JSON.stringify(comments) },
          transaction
        );
        return { thread_id: threadId };
      },
      false
    );
    return this.projectThread(await this.thread(id, threadId, ctx));
  }
  async patchThread(
    id: string,
    threadId: string,
    body: { expected_thread_version: number; resolved: boolean },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        const row = await this.thread(id, threadId, transaction, access);
        if (row.thread_version !== body.expected_thread_version)
          fail(409, 'THREAD_CONFLICT');
        if (
          row.creator_profile_id !== access.actorProfileId &&
          !access.capabilities.manage_context &&
          !access.capabilities.review_lanes.length
        )
          fail(403, 'THREAD_RESOLUTION_NOT_ALLOWED');
        await this.core.db.query(
          `UPDATE ${AD_THREADS} SET resolved=:resolved,thread_version=thread_version+1 WHERE id=:threadId AND context_id=:id`,
          { id, threadId, resolved: body.resolved },
          transaction
        );
        await this.core.audit(
          access,
          'thread_resolution_changed',
          { thread_id: threadId, resolved: body.resolved },
          transaction
        );
        return { thread_id: threadId };
      },
      false
    );
    return this.projectThread(await this.thread(id, threadId, ctx));
  }
  async review(
    id: string,
    revisionId: string,
    lane: ReviewLane,
    body: { expected_review_version: number; status: string; reason?: string },
    mutation: Mutation,
    ctx: RequestContext
  ) {
    await this.core.mutate(
      id,
      mutation,
      ctx,
      async (access, transaction) => {
        if (!access.capabilities.review_lanes.includes(lane))
          fail(403, 'REVIEW_ASSIGNMENT_REQUIRED');
        if (lane === 'rights' && !access.capabilities.read_rights_evidence)
          fail(403, 'RIGHTS_EVIDENCE_ACCESS_REQUIRED');
        const revision = await this.core.revisionRow(
          id,
          revisionId,
          transaction
        );
        const current = await this.core.db.one<
          ReviewRow & { decision_history_json: unknown }
        >(
          `SELECT * FROM ${AD_REVIEWS} WHERE revision_id=:revisionId AND lane=:lane FOR UPDATE`,
          { revisionId, lane },
          transaction
        );
        if (!current) fail(404, 'UNAVAILABLE');
        if (current.review_version !== body.expected_review_version)
          fail(409, 'REVIEW_CONFLICT');
        if (body.status !== 'accepted' && !body.reason)
          fail(422, 'REVIEW_REASON_REQUIRED');
        const snapshot = parseJson<
          Pick<ContextRecord, 'modules' | 'asset_links' | 'profile'>
        >(revision.snapshot_json);
        if (
          body.status === 'accepted' &&
          this.core
            .issues({ ...access.context, ...snapshot })
            .some((issue) => issue.lane === lane)
        )
          fail(422, 'REVIEW_ISSUES_REMAIN');
        if (body.status === 'accepted')
          await this.core.validateAssetReferences(
            { ...access, context: { ...access.context, ...snapshot } },
            transaction,
            true
          );
        const history = parseJson<Record<string, unknown>[]>(
          current.decision_history_json ?? []
        );
        if (history.length >= 200) fail(413, 'REVIEW_HISTORY_LIMIT');
        history.push({
          review_version: current.review_version + 1,
          status: body.status,
          reviewer_profile_id: access.actorProfileId,
          reason: body.reason ?? null,
          updated_at: Date.now()
        });
        await this.core.db.query(
          `UPDATE ${AD_REVIEWS} SET status=:status,review_version=review_version+1,reviewer_profile_id=:actor,reason=:reason,updated_at=:updated,decision_history_json=:history WHERE revision_id=:revisionId AND lane=:lane`,
          {
            status: body.status,
            actor: access.actorProfileId,
            reason: body.reason ?? null,
            history: JSON.stringify(history),
            updated: Date.now(),
            revisionId,
            lane
          },
          transaction
        );
        await this.core.audit(
          access,
          'review_decided',
          {
            revision_id: revisionId,
            lane,
            status: body.status,
            review_version: current.review_version + 1
          },
          transaction
        );
        return { revision_id: revisionId };
      },
      false
    );
    const access = await this.core.authorizeContext(id, ctx);
    return (await this.core.reviews(revisionId, access, ctx)).find(
      (review) => review.lane === lane
    )!;
  }
}
export const artworkDocumentationReviewService =
  new ArtworkDocumentationReviewService();
