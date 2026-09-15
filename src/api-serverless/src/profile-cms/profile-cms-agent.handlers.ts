import type { Request } from 'express';
import Joi from 'joi';
import { Timer } from '@/time';
import { RequestContext } from '@/request.context';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  CreateProfileCmsAgentGrantRequest,
  ListProfileCmsAgentGrantsRequest,
  RevokeProfileCmsAgentGrantRequest,
  ListProfileCmsAgentProposalsRequest,
  GetProfileCmsAgentDraftRequest,
  ValidateProfileCmsAgentCandidateRequest,
  SubmitProfileCmsAgentProposalRequest,
  GetProfileCmsAgentProposalRequest
} from '@/api/generated/routes/operations';
import { ApiCreateProfileCmsAgentGrantRequest } from '@/api/generated/models/ApiCreateProfileCmsAgentGrantRequest';
import { ApiValidateProfileCmsAgentCandidateRequest } from '@/api/generated/models/ApiValidateProfileCmsAgentCandidateRequest';
import { ApiSubmitProfileCmsAgentProposalRequest } from '@/api/generated/models/ApiSubmitProfileCmsAgentProposalRequest';
import { ApiReviewProfileCmsAgentProposalRequest } from '@/api/generated/models/ApiReviewProfileCmsAgentProposalRequest';
import {
  GetOwnerProfileCmsAgentProposalRequest,
  ReviewProfileCmsAgentProposalRequest
} from '@/api/generated/routes/operations';
import { assertCmsAgentJsonBounded } from '@/profile-cms/profile-cms-agent-candidate';
import {
  CmsAgentOwner,
  profileCmsAgentApiService as service
} from '@/api/profile-cms/profile-cms-agent.api.service';

type AgentRequest = Pick<Request, 'headers' | 'res' | 'user'> & {
  body?: unknown;
  query: unknown;
  params: unknown;
};

const hash = Joi.string()
  .pattern(/^sha256:[a-f0-9]{64}$/)
  .required();
const idSchema = Joi.object({
  id: Joi.string()
    .max(100)
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .required()
}).required();
const pageSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(20),
  offset: Joi.number().integer().min(0).max(10000).default(0)
}).required();
const issueSchema = Joi.object<ApiCreateProfileCmsAgentGrantRequest>({
  label: Joi.string().trim().min(1).max(80).required(),
  expected_package_hash: hash,
  expires_in_seconds: Joi.number().integer().min(60).max(86400).default(3600)
}).required();
const candidateFields = {
  draft_id: Joi.string().min(1).max(100).required(),
  base_version: Joi.number().integer().min(1).required(),
  base_package_hash: hash,
  candidate_package: Joi.object().unknown(true).required()
};
const candidateSchema =
  Joi.object<ApiValidateProfileCmsAgentCandidateRequest>(
    candidateFields
  ).required();
const submitSchema = Joi.object<ApiSubmitProfileCmsAgentProposalRequest>({
  ...candidateFields,
  idempotency_key: Joi.string().uuid().required(),
  summary: Joi.string().trim().min(1).max(1000).required()
}).required();

async function run<T>(
  req: AgentRequest,
  action: (ctx: RequestContext) => Promise<T>
): Promise<T> {
  req.res?.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff'
  });
  try {
    if (req.body !== undefined) assertCmsAgentJsonBounded(req.body);
    return await action({
      timer: Timer.getFromRequest(req as unknown as Request)
    });
  } catch (error) {
    if (error instanceof ApiCompliantException) throw error;
    throw new CustomApiCompliantException(
      500,
      'CMS agent operation failed',
      'cms_agent_operation_failed'
    );
  } finally {
    // Request/SQL errors must not disclose private draft content or credentials to error integrations.
    req.body = undefined;
    delete req.headers.authorization;
    delete req.headers.cookie;
  }
}
function id(req: AgentRequest): string {
  return getValidatedByJoiOrThrow(req.params, idSchema).id;
}
function owner(req: AgentRequest): CmsAgentOwner {
  const user = getValidatedByJoiOrThrow(
    req.user,
    Joi.object({
      wallet: Joi.string()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .required(),
      role: Joi.string().max(100).allow(null).optional(),
      exp: Joi.number().optional()
    }).required()
  );
  return { wallet: user.wallet.toLowerCase(), role: user.role ?? null };
}
function token(req: AgentRequest): string {
  const match = /^Bearer (cms_agent_[a-f0-9-]{36}\.[a-f0-9]{64})$/.exec(
    req.headers.authorization ?? ''
  );
  if (!match)
    throw new CustomApiCompliantException(
      401,
      'CMS agent grant is unavailable',
      'cms_agent_invalid_grant'
    );
  return match[1];
}
function emptyQuery(req: AgentRequest): void {
  getValidatedByJoiOrThrow(req.query, Joi.object({}).required());
}

export function handleCreateProfileCmsAgentGrant(
  req: CreateProfileCmsAgentGrantRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.issue(
      id(req),
      getValidatedByJoiOrThrow(req.body, issueSchema),
      owner(req),
      ctx
    );
  });
}
export function handleListProfileCmsAgentGrants(
  req: ListProfileCmsAgentGrantsRequest
) {
  return run(req, (ctx) => {
    const page = getValidatedByJoiOrThrow(req.query, pageSchema);
    return service.listGrants(
      id(req),
      owner(req),
      page.limit,
      page.offset,
      ctx
    );
  });
}
export function handleRevokeProfileCmsAgentGrant(
  req: RevokeProfileCmsAgentGrantRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.revoke(id(req), owner(req), ctx);
  });
}
export function handleListProfileCmsAgentProposals(
  req: ListProfileCmsAgentProposalsRequest
) {
  return run(req, (ctx) => {
    const page = getValidatedByJoiOrThrow(req.query, pageSchema);
    return service.listProposals(
      id(req),
      owner(req),
      page.limit,
      page.offset,
      ctx
    );
  });
}
export function handleGetProfileCmsAgentDraft(
  req: GetProfileCmsAgentDraftRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.readDraft(token(req), ctx);
  });
}
export function handleValidateProfileCmsAgentCandidate(
  req: ValidateProfileCmsAgentCandidateRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.validate(
      token(req),
      getValidatedByJoiOrThrow(req.body, candidateSchema),
      ctx
    );
  });
}
export function handleSubmitProfileCmsAgentProposal(
  req: SubmitProfileCmsAgentProposalRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.submit(
      token(req),
      getValidatedByJoiOrThrow(req.body, submitSchema),
      ctx
    );
  });
}
export function handleGetProfileCmsAgentProposal(
  req: GetProfileCmsAgentProposalRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.readProposal(token(req), id(req), ctx);
  });
}

const reviewSchema = Joi.object<ApiReviewProfileCmsAgentProposalRequest>({
  status: Joi.string().valid('rejected', 'applied').required(),
  expected_draft_id: Joi.string().max(100).required(),
  expected_base_package_hash: hash,
  expected_candidate_package_hash: hash,
  result_draft_id: Joi.when('status', {
    is: 'applied',
    then: Joi.string().max(100).required(),
    otherwise: Joi.forbidden()
  }),
  result_package_hash: Joi.when('status', {
    is: 'applied',
    then: hash,
    otherwise: Joi.forbidden()
  })
}).required();

export function handleGetOwnerProfileCmsAgentProposal(
  req: GetOwnerProfileCmsAgentProposalRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.readOwnerProposal(id(req), owner(req), ctx);
  });
}
export function handleReviewProfileCmsAgentProposal(
  req: ReviewProfileCmsAgentProposalRequest
) {
  return run(req, (ctx) => {
    emptyQuery(req);
    return service.reviewProposal(
      id(req),
      getValidatedByJoiOrThrow(req.body, reviewSchema),
      owner(req),
      ctx
    );
  });
}
