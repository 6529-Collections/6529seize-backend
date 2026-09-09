import { getAuthenticationContext } from '@/api/auth/auth';
import * as Operations from '@/api/generated/routes/operations';
import { Request } from 'express';
import * as Joi from 'joi';
import { ApiCompliantException } from '@/exceptions';
import { Timer } from '@/time';
import { RequestContext } from '@/request.context';
import { artworkDocumentationService as core } from '@/artwork-documentation/artwork-documentation.service';
import {
  artworkDocumentationReviewService as review,
  ContextFilters
} from '@/artwork-documentation/artwork-documentation.review';
import {
  ModuleId,
  MODULE_IDS,
  Mutation,
  REVIEW_LANES,
  ReviewLane
} from '@/artwork-documentation/artwork-documentation.types';
import {
  fail,
  normalizeJson,
  parseIfMatch
} from '@/artwork-documentation/artwork-documentation.validation';

type DocumentationRequest = Pick<
  Request<unknown, unknown, unknown, unknown>,
  'params' | 'body' | 'query' | 'method' | 'path' | 'get'
> & {
  res?: {
    set(field: string | Record<string, string>, value?: string): unknown;
  };
};
const uuid = Joi.string().guid({ version: ['uuidv4', 'uuidv5'] });
const identifier = Joi.string().min(1).max(100);
const string = (max = 4000) => Joi.string().min(1).max(max);
const profileBody = Joi.object({
  profile_id: identifier.required(),
  profile_version: Joi.number().integer().min(1).required()
});
const fieldOperation = Joi.object({
  op: Joi.string().valid('set', 'unset').required(),
  field: identifier.required(),
  answer: Joi.object().unknown(true)
});

function body<T>(req: DocumentationRequest, schema: Joi.Schema): T {
  const result = schema.validate(normalizeJson(req.body), {
    convert: false,
    abortEarly: true,
    allowUnknown: false
  });
  if (result.error) fail(422, 'INVALID_REQUEST');
  return result.value as T;
}
function mutation(req: DocumentationRequest, expected = false): Mutation {
  const key = req.get('Idempotency-Key');
  if (uuid.required().validate(key).error)
    fail(428, 'IDEMPOTENCY_KEY_REQUIRED');
  return {
    key: key!,
    route: `${req.method}:${req.path}`,
    body: req.body ?? null,
    expectedVersion: expected ? parseIfMatch(req.get('If-Match')) : undefined
  };
}
async function execute<T>(
  req: DocumentationRequest,
  operation: (ctx: RequestContext) => Promise<unknown>
): Promise<T> {
  req.res?.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff'
  });
  try {
    for (const value of Object.values(req.params as Record<string, unknown>))
      if (identifier.validate(value).error) fail(404, 'UNAVAILABLE');
    const expressRequest = req as unknown as Request;
    const timer = Timer.getFromRequest(expressRequest);
    const ctx = {
      timer,
      authenticationContext: await getAuthenticationContext(
        expressRequest,
        timer
      )
    };
    const result = await operation(ctx);
    if (
      result &&
      typeof result === 'object' &&
      'draft_version' in result &&
      typeof result.draft_version === 'number'
    )
      req.res?.set('ETag', `"draft-${result.draft_version}"`);
    return result as T;
  } catch (error) {
    // Documentation is private: do not let error integrations capture request answers or SQL values.
    req.body = undefined;
    if (error instanceof ApiCompliantException) throw error;
    return fail(500, 'DOCUMENTATION_OPERATION_FAILED');
  }
}
function page(req: DocumentationRequest): { cursor?: string; limit?: number } {
  const query = req.query as Record<string, unknown>;
  return {
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  };
}

export function handleGetDocumentationProfiles(
  req: Operations.ArtworkDocumentationGetDocumentationProfilesRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationProfilesResponse> {
  return execute(req, (ctx) => core.profiles(ctx));
}
export function handleListDocumentationWorks(
  req: Operations.ArtworkDocumentationListDocumentationWorksRequest
): Promise<Operations.ArtworkDocumentationListDocumentationWorksResponse> {
  return execute(req, (ctx) => review.listContexts(ctx, page(req)));
}
export function handleGetDocumentationWork(
  req: Operations.ArtworkDocumentationGetDocumentationWorkRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationWorkResponse> {
  return execute(req, (ctx) => review.work(req.params.workId, ctx));
}
export function handleGetDocumentationContext(
  req: Operations.ArtworkDocumentationGetDocumentationContextRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationContextResponse> {
  return execute(req, (ctx) => core.getContext(req.params.id, ctx));
}
export function handleGetDocumentationPublicPreview(
  req: Operations.ArtworkDocumentationGetDocumentationPublicPreviewRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationPublicPreviewResponse> {
  return execute(req, (ctx) => core.publicPreview(req.params.id, ctx));
}
export function handleCreateDocumentationContext(
  req: Operations.ArtworkDocumentationCreateDocumentationContextRequest
): Promise<Operations.ArtworkDocumentationCreateDocumentationContextResponse> {
  return execute(req, (ctx) =>
    core.createContextForWork(
      req.params.workId,
      body(
        req,
        profileBody.keys({
          program_id: identifier,
          acknowledge_empty_context: Joi.boolean().valid(true).required()
        })
      ),
      mutation(req),
      ctx
    )
  );
}
export function handleCreateDocumentationWork(
  req: Operations.ArtworkDocumentationCreateDocumentationWorkRequest
): Promise<Operations.ArtworkDocumentationCreateDocumentationWorkResponse> {
  return execute(req, (ctx) =>
    core.createWork(
      body(
        req,
        profileBody.keys({
          program_id: identifier,
          source_drop_id: identifier,
          start_mode: Joi.string()
            .valid(
              'standalone',
              'during_submission',
              'after_submission',
              'coordinator_import'
            )
            .required()
        })
      ),
      mutation(req),
      ctx
    )
  );
}
export function handlePatchDocumentationModule(
  req: Operations.ArtworkDocumentationPatchDocumentationModuleRequest
): Promise<Operations.ArtworkDocumentationPatchDocumentationModuleResponse> {
  return execute(req, (ctx) => {
    if (!MODULE_IDS.includes(req.params.moduleId as ModuleId))
      fail(422, 'INVALID_MODULE');
    return core.patchModule(
      req.params.id,
      req.params.moduleId as ModuleId,
      body(
        req,
        Joi.object({
          schema_version: Joi.number().valid(1).required(),
          operations: Joi.array()
            .items(fieldOperation)
            .min(1)
            .max(100)
            .required(),
          expected_artist_record_version: Joi.number().integer().min(0),
          replacement_reason: string(1000).min(20)
        })
      ),
      mutation(req, true),
      ctx
    );
  });
}
export function handlePinDocumentationArtist(
  req: Operations.ArtworkDocumentationPinDocumentationArtistRequest
): Promise<Operations.ArtworkDocumentationPinDocumentationArtistResponse> {
  return execute(req, (ctx) =>
    core.pinArtist(
      req.params.id,
      body<{ artist_record_revision_id: string }>(
        req,
        Joi.object({ artist_record_revision_id: uuid.required() })
      ).artist_record_revision_id,
      mutation(req, true),
      ctx
    )
  );
}
export function handleLinkDocumentationSource(
  req: Operations.ArtworkDocumentationLinkDocumentationSourceRequest
): Promise<Operations.ArtworkDocumentationLinkDocumentationSourceResponse> {
  return execute(req, (ctx) =>
    core.linkSource(
      req.params.id,
      body<{ drop_id: string }>(
        req,
        Joi.object({ drop_id: identifier.required() })
      ).drop_id,
      mutation(req, true),
      ctx
    )
  );
}
export function handlePreviewDocumentationSource(
  req: Operations.ArtworkDocumentationPreviewDocumentationSourceRequest
): Promise<Operations.ArtworkDocumentationPreviewDocumentationSourceResponse> {
  return execute(req, (ctx) =>
    core.sourcePreview(req.params.id, req.params.receiptId, ctx)
  );
}
export function handleImportDocumentationSource(
  req: Operations.ArtworkDocumentationImportDocumentationSourceRequest
): Promise<Operations.ArtworkDocumentationImportDocumentationSourceResponse> {
  return execute(req, (ctx) =>
    core.importSource(
      req.params.id,
      body(
        req,
        Joi.object({
          source_receipt_id: uuid.required(),
          fields: Joi.array()
            .items(
              Joi.object({
                source_path: identifier.required(),
                target_field: identifier.required(),
                overwrite: Joi.boolean()
              })
            )
            .min(1)
            .max(30)
            .required()
        })
      ),
      mutation(req, true),
      ctx
    )
  );
}
export function handleConfirmDocumentation(
  req: Operations.ArtworkDocumentationConfirmDocumentationRequest
): Promise<Operations.ArtworkDocumentationConfirmDocumentationResponse> {
  return execute(req, (ctx) =>
    core.confirm(
      req.params.id,
      body(
        req,
        Joi.object({
          confirmation_copy_version: identifier.required(),
          accepted: Joi.boolean().valid(true).required()
        })
      ),
      mutation(req, true),
      ctx
    )
  );
}
export function handleListDocumentationRevisions(
  req: Operations.ArtworkDocumentationListDocumentationRevisionsRequest
): Promise<Operations.ArtworkDocumentationListDocumentationRevisionsResponse> {
  return execute(req, (ctx) =>
    review.listRevisions(req.params.id, ctx, page(req))
  );
}
export function handleGetDocumentationRevision(
  req: Operations.ArtworkDocumentationGetDocumentationRevisionRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationRevisionResponse> {
  return execute(req, (ctx) =>
    core.getRevision(req.params.id, req.params.revisionId, ctx)
  );
}
export function handlePatchDocumentationContext(
  req: Operations.ArtworkDocumentationPatchDocumentationContextRequest
): Promise<Operations.ArtworkDocumentationPatchDocumentationContextResponse> {
  return execute(req, (ctx) =>
    review.lifecycle(
      req.params.id,
      body<{ lifecycle: 'active' | 'archived' }>(
        req,
        Joi.object({
          lifecycle: Joi.string().valid('active', 'archived').required()
        })
      ).lifecycle,
      mutation(req, true),
      ctx
    )
  );
}
export function handleListDocumentationProgram(
  req: Operations.ArtworkDocumentationListDocumentationProgramRequest
): Promise<Operations.ArtworkDocumentationListDocumentationProgramResponse> {
  return execute(req, (ctx) =>
    review.listContexts(
      ctx,
      {
        ...page(req),
        confirmation_status: req.query.confirmation_status,
        review_lane: req.query.review_lane,
        outstanding_action: req.query.outstanding_action,
        profile_id: req.query.profile_id,
        profile_version:
          req.query.profile_version === undefined
            ? undefined
            : Number(req.query.profile_version)
      } as ContextFilters,
      req.params.programId
    )
  );
}
export function handlePreviewDocumentationUpgrade(
  req: Operations.ArtworkDocumentationPreviewDocumentationUpgradeRequest
): Promise<Operations.ArtworkDocumentationPreviewDocumentationUpgradeResponse> {
  return execute(req, (ctx) => {
    const input = body<{ profile_id: string; profile_version: number }>(
      req,
      profileBody
    );
    return review.upgradePreview(
      req.params.id,
      input.profile_id,
      input.profile_version,
      ctx
    );
  });
}
export function handleUpgradeDocumentationProfile(
  req: Operations.ArtworkDocumentationUpgradeDocumentationProfileRequest
): Promise<Operations.ArtworkDocumentationUpgradeDocumentationProfileResponse> {
  return execute(req, (ctx) => {
    const input = body<{ profile_id: string; profile_version: number }>(
      req,
      profileBody
    );
    return review.upgrade(
      req.params.id,
      input.profile_id,
      input.profile_version,
      mutation(req, true),
      ctx
    );
  });
}
export function handleListDocumentationGrants(
  req: Operations.ArtworkDocumentationListDocumentationGrantsRequest
): Promise<Operations.ArtworkDocumentationListDocumentationGrantsResponse> {
  return execute(req, (ctx) => review.listGrants(req.params.id, ctx));
}
export function handleGrantDocumentationAccess(
  req: Operations.ArtworkDocumentationGrantDocumentationAccessRequest
): Promise<Operations.ArtworkDocumentationGrantDocumentationAccessResponse> {
  return execute(req, (ctx) => {
    const input = body<{ subject_profile_id: string; capabilities: unknown }>(
      req,
      Joi.object({
        subject_profile_id: identifier.required(),
        capabilities: Joi.object().unknown(true).required()
      })
    );
    return review.grant(
      req.params.id,
      input.subject_profile_id,
      input.capabilities,
      mutation(req),
      ctx
    );
  });
}
export function handleRevokeDocumentationAccess(
  req: Operations.ArtworkDocumentationRevokeDocumentationAccessRequest
): Promise<Operations.ArtworkDocumentationRevokeDocumentationAccessResponse> {
  return execute(req, (ctx) =>
    review.revoke(req.params.id, req.params.grantId, mutation(req), ctx)
  );
}
export function handleListDocumentationThreads(
  req: Operations.ArtworkDocumentationListDocumentationThreadsRequest
): Promise<Operations.ArtworkDocumentationListDocumentationThreadsResponse> {
  return execute(req, (ctx) => review.listThreads(req.params.id, ctx));
}
export function handleCreateDocumentationThread(
  req: Operations.ArtworkDocumentationCreateDocumentationThreadRequest
): Promise<Operations.ArtworkDocumentationCreateDocumentationThreadResponse> {
  return execute(req, (ctx) =>
    review.createThread(
      req.params.id,
      body(
        req,
        Joi.object({
          field_path: identifier,
          revision_id: uuid,
          audience: Joi.string()
            .valid('artist_and_reviewers', 'reviewers_only')
            .required(),
          restricted_class: Joi.string()
            .valid('ordinary', 'rights', 'archival', 'contact')
            .required(),
          text: string().required()
        })
      ),
      mutation(req),
      ctx
    )
  );
}
export function handleCommentDocumentationThread(
  req: Operations.ArtworkDocumentationCommentDocumentationThreadRequest
): Promise<Operations.ArtworkDocumentationCommentDocumentationThreadResponse> {
  return execute(req, (ctx) =>
    review.comment(
      req.params.id,
      req.params.threadId,
      body<{ text: string }>(req, Joi.object({ text: string().required() }))
        .text,
      mutation(req),
      ctx
    )
  );
}
export function handlePatchDocumentationThread(
  req: Operations.ArtworkDocumentationPatchDocumentationThreadRequest
): Promise<Operations.ArtworkDocumentationPatchDocumentationThreadResponse> {
  return execute(req, (ctx) =>
    review.patchThread(
      req.params.id,
      req.params.threadId,
      body(
        req,
        Joi.object({
          expected_thread_version: Joi.number().integer().min(1).required(),
          resolved: Joi.boolean().required()
        })
      ),
      mutation(req),
      ctx
    )
  );
}
export function handleReviewDocumentation(
  req: Operations.ArtworkDocumentationReviewDocumentationRequest
): Promise<Operations.ArtworkDocumentationReviewDocumentationResponse> {
  return execute(req, (ctx) => {
    if (!REVIEW_LANES.includes(req.params.lane as ReviewLane))
      fail(422, 'INVALID_REVIEW_LANE');
    return review.review(
      req.params.id,
      req.params.revisionId,
      req.params.lane as ReviewLane,
      body(
        req,
        Joi.object({
          expected_review_version: Joi.number().integer().min(1).required(),
          status: Joi.string()
            .valid('pending', 'changes_requested', 'accepted')
            .required(),
          reason: string()
        })
      ),
      mutation(req),
      ctx
    );
  });
}

export {
  execute as executeDocumentationRequest,
  body as documentationBody,
  mutation as documentationMutation
};
export {
  handleStartDocumentationUpload,
  handleGetDocumentationUpload,
  handleSignDocumentationParts,
  handleCompleteDocumentationUpload,
  handleCancelDocumentationUpload,
  handleLinkDocumentationAsset,
  handlePatchDocumentationAssetLink,
  handleUnlinkDocumentationAsset,
  handleDownloadDocumentationAsset
} from './artwork-documentation-assets.handlers';
