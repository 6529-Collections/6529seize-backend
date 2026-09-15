import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';
import { ApiCreateProfileCmsAgentGrantRequest } from '@/api/generated/models/ApiCreateProfileCmsAgentGrantRequest';
import { ApiCreatedProfileCmsAgentGrant } from '@/api/generated/models/ApiCreatedProfileCmsAgentGrant';
import { ApiProfileCmsAgentGrant } from '@/api/generated/models/ApiProfileCmsAgentGrant';
import {
  ApiProfileCmsAgentDraft,
  ApiProfileCmsAgentDraftProposalSchemaEnum
} from '@/api/generated/models/ApiProfileCmsAgentDraft';
import {
  ApiProfileCmsAgentProposal,
  ApiProfileCmsAgentProposalStatusEnum
} from '@/api/generated/models/ApiProfileCmsAgentProposal';
import { ApiReviewProfileCmsAgentProposalRequest } from '@/api/generated/models/ApiReviewProfileCmsAgentProposalRequest';
import {
  ApiProfileCmsAgentProposalSummary,
  ApiProfileCmsAgentProposalSummaryStatusEnum
} from '@/api/generated/models/ApiProfileCmsAgentProposalSummary';
import { ApiProfileCmsAgentConstraintsHashNormalizationEnum } from '@/api/generated/models/ApiProfileCmsAgentConstraints';
import { ApiProfileCmsAgentCandidateValidation } from '@/api/generated/models/ApiProfileCmsAgentCandidateValidation';
import { ApiValidateProfileCmsAgentCandidateRequest } from '@/api/generated/models/ApiValidateProfileCmsAgentCandidateRequest';
import { ApiSubmitProfileCmsAgentProposalRequest } from '@/api/generated/models/ApiSubmitProfileCmsAgentProposalRequest';
import {
  ApiCompliantException,
  CustomApiCompliantException
} from '@/exceptions';
import { ProfileCmsAgentGrantEntity } from '@/entities/IProfileCmsAgentGrant';
import { ProfileCmsAgentProposalEntity } from '@/entities/IProfileCmsAgentProposal';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsAgentGrantsDb,
  profileCmsAgentGrantsDb,
  CmsAgentProposalSummary
} from '@/profile-cms/profile-cms-agent-grants.db';
import {
  ProfileCmsPackagesDb,
  profileCmsPackagesDb
} from '@/profile-cms/profile-cms-packages.db';
import {
  validateCmsAgentCandidate,
  assertCmsAgentJsonBounded,
  CMS_AGENT_MAX_BYTES,
  CMS_AGENT_MAX_DEPTH,
  CMS_AGENT_MAX_NODES
} from '@/profile-cms/profile-cms-agent-candidate';
import {
  cmsPackageSchema,
  hashCanonicalJson,
  computeCmsPackageHash
} from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';

export const CMS_AGENT_LIMITS = {
  requests: 200,
  proposals: 20,
  active: 5,
  dailyGrants: 20,
  dailyProposals: 100
} as const;
export interface CmsAgentOwner {
  readonly wallet: string;
  readonly role: string | null;
}

function fail(status: number, code: string, message: string): never {
  throw new CustomApiCompliantException(status, message, code);
}
function invalidGrant(): never {
  return fail(401, 'cms_agent_invalid_grant', 'CMS agent grant is unavailable');
}
function quota(): never {
  return fail(429, 'cms_agent_quota_exhausted', 'CMS agent quota exhausted');
}
function enabled(): void {
  if (process.env.FEATURE_PROFILE_CMS_AGENT_PROPOSALS === 'false') {
    fail(
      503,
      'cms_agent_disabled',
      'CMS agent proposals are temporarily disabled'
    );
  }
}
function digest(secret: string): string {
  return createHash('sha256')
    .update(`6529.cms.agent.v1:${secret}`)
    .digest('hex');
}
function matches(
  grant: ProfileCmsAgentGrantEntity | null,
  secret: string
): grant is ProfileCmsAgentGrantEntity {
  return (
    !!grant &&
    /^[a-f0-9]{64}$/.test(grant.token_hash) &&
    timingSafeEqual(
      Buffer.from(grant.token_hash, 'hex'),
      Buffer.from(digest(secret), 'hex')
    )
  );
}
function parseToken(token: string): { id: string; secret: string } {
  const match = /^cms_agent_([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return invalidGrant();
  return { id: match[1], secret: match[2] };
}

export class ProfileCmsAgentApiService {
  constructor(
    private readonly grants: ProfileCmsAgentGrantsDb,
    private readonly packages: ProfileCmsPackagesDb,
    private readonly now: () => number = Date.now
  ) {}

  async issue(
    draftId: string,
    body: ApiCreateProfileCmsAgentGrantRequest,
    owner: CmsAgentOwner,
    ctx: RequestContext
  ): Promise<ApiCreatedProfileCmsAgentGrant> {
    enabled();
    return this.ownerDraft(draftId, owner, ctx, async (draft, tx, handle) => {
      this.assertDraft(draft);
      assertCmsAgentJsonBounded(draft.cms_package);
      const base = cmsPackageSchema.parse(draft.cms_package);
      if (
        draft.profile_handle !== handle ||
        base.profile.handle.toLowerCase() !== handle.toLowerCase() ||
        base.package_id !== draft.package_id ||
        computeCmsPackageHash(base) !== draft.package_hash
      )
        this.stale();
      if (draft.package_hash !== body.expected_package_hash) this.stale();
      const now = this.now();
      const limits = await this.grants.grantQuota(draft.profile_id, now, tx);
      if (
        limits.active >= CMS_AGENT_LIMITS.active ||
        limits.daily >= CMS_AGENT_LIMITS.dailyGrants
      )
        quota();
      const id = randomUUID();
      const secret = randomBytes(32).toString('hex');
      const grant: ProfileCmsAgentGrantEntity = {
        id,
        profile_id: draft.profile_id,
        draft_id: draft.id,
        package_id: draft.package_id,
        base_version: draft.version,
        base_package_hash: draft.package_hash,
        issued_by_wallet: owner.wallet.toLowerCase(),
        token_hash: digest(secret),
        label: body.label,
        created_at: now,
        expires_at: now + (body.expires_in_seconds ?? 3600) * 1000,
        revoked_at: null,
        request_count: 0,
        proposal_count: 0
      };
      await this.grants.insertGrant(grant, tx);
      await this.event(grant, 'issued', null, tx, owner.wallet);
      return { grant: this.toGrant(grant), token: `cms_agent_${id}.${secret}` };
    });
  }

  async listGrants(
    draftId: string,
    owner: CmsAgentOwner,
    limit: number,
    offset: number,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentGrant[]> {
    return this.ownerDraft(draftId, owner, ctx, async (_draft, tx) =>
      (await this.grants.listGrants(draftId, limit, offset, tx)).map((row) =>
        this.toGrant(row)
      )
    );
  }

  async revoke(
    id: string,
    owner: CmsAgentOwner,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentGrant> {
    const candidate = await this.grants.findGrant(id, ctx);
    if (!candidate)
      fail(404, 'cms_agent_unavailable', 'CMS agent grant is unavailable');
    return this.ownerDraft(
      candidate.draft_id,
      owner,
      ctx,
      async (_draft, tx) => {
        const grant = await this.grants.findGrant(id, tx, true);
        if (!grant)
          fail(404, 'cms_agent_unavailable', 'CMS agent grant is unavailable');
        if (grant.revoked_at !== null) return this.toGrant(grant);
        const now = this.now();
        await this.grants.revoke(id, now, tx);
        await this.event(grant, 'revoked', null, tx, owner.wallet);
        return this.toGrant({ ...grant, revoked_at: now });
      }
    );
  }

  async listProposals(
    draftId: string,
    owner: CmsAgentOwner,
    limit: number,
    offset: number,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentProposalSummary[]> {
    return this.ownerDraft(draftId, owner, ctx, async (_draft, tx) =>
      (await this.grants.listProposals(draftId, limit, offset, tx)).map((row) =>
        this.toProposalSummary(row)
      )
    );
  }

  async readDraft(
    token: string,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentDraft> {
    return this.withGrant(token, ctx, async (grant, draft) => ({
      grant: this.toGrant(grant),
      cms_package: { ...cmsPackageSchema.parse(draft.cms_package) },
      proposal_schema:
        ApiProfileCmsAgentDraftProposalSchemaEnum._6529CmsAgentCandidateV1,
      constraints: {
        max_request_bytes: CMS_AGENT_MAX_BYTES,
        max_json_depth: CMS_AGENT_MAX_DEPTH,
        max_json_nodes: CMS_AGENT_MAX_NODES,
        protected_fields: [
          'profile',
          'package_id',
          'site.base_path',
          'payload.assets'
        ],
        hash_normalization:
          ApiProfileCmsAgentConstraintsHashNormalizationEnum.ServerRecomputes,
        publication_authority: false
      }
    }));
  }

  async validate(
    token: string,
    body: ApiValidateProfileCmsAgentCandidateRequest,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentCandidateValidation> {
    return this.withGrant(token, ctx, async (_grant, draft) =>
      this.validateCandidate(draft, body)
    );
  }

  async submit(
    token: string,
    body: ApiSubmitProfileCmsAgentProposalRequest,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentProposal> {
    return this.withGrant(token, ctx, async (grant, draft, tx) => {
      const requestHash = hashCanonicalJson(body);
      const existing = await this.grants.findIdempotent(
        grant.id,
        body.idempotency_key,
        tx
      );
      if (existing) {
        if (existing.request_hash !== requestHash)
          fail(
            409,
            'cms_agent_idempotency_conflict',
            'Idempotency key already identifies another proposal'
          );
        return this.toProposal(existing);
      }
      const candidate = this.validateCandidate(draft, body);
      if (!candidate.valid)
        fail(
          400,
          'cms_agent_invalid_candidate',
          'Validate and correct the candidate before submitting'
        );
      if (
        grant.proposal_count >= CMS_AGENT_LIMITS.proposals ||
        (await this.grants.proposalCount(
          grant.profile_id,
          this.now() - 86400000,
          tx
        )) >= CMS_AGENT_LIMITS.dailyProposals
      )
        quota();
      const proposal: ProfileCmsAgentProposalEntity = {
        id: randomUUID(),
        grant_id: grant.id,
        profile_id: grant.profile_id,
        draft_id: draft.id,
        base_version: draft.version,
        base_package_hash: draft.package_hash,
        candidate_package_hash: candidate.candidate_package_hash,
        idempotency_key: body.idempotency_key,
        request_hash: requestHash,
        summary: body.summary,
        created_at: this.now(),
        candidate_package: candidate.candidate_package,
        status: 'pending',
        reviewed_at: null,
        result_draft_id: null,
        result_package_hash: null
      };
      await this.grants.insertProposal(proposal, tx);
      await this.event(grant, 'proposed', proposal.id, tx);
      return this.toProposal(proposal);
    });
  }

  async readProposal(
    token: string,
    id: string,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentProposal> {
    return this.withGrant(token, ctx, async (grant, _draft, tx) => {
      const row = await this.grants.findProposal(id, tx);
      if (!row || row.grant_id !== grant.id)
        fail(404, 'cms_agent_unavailable', 'CMS agent proposal is unavailable');
      return this.toProposal(row);
    });
  }

  private validateCandidate(
    draft: ProfileCmsPackageEntity,
    body: ApiValidateProfileCmsAgentCandidateRequest
  ): ApiProfileCmsAgentCandidateValidation {
    if (
      body.draft_id !== draft.id ||
      body.base_version !== draft.version ||
      body.base_package_hash !== draft.package_hash
    )
      this.stale();
    const result = validateCmsAgentCandidate(
      cmsPackageSchema.parse(draft.cms_package),
      body.candidate_package,
      this.now()
    );
    // Protocol and generated OpenAPI validation enums have equivalent wire values.
    return result as unknown as ApiProfileCmsAgentCandidateValidation;
  }

  async readOwnerProposal(
    id: string,
    owner: CmsAgentOwner,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentProposal> {
    return this.ownerProposal(id, owner, ctx, async (proposal) =>
      this.toProposal(proposal)
    );
  }

  async reviewProposal(
    id: string,
    body: ApiReviewProfileCmsAgentProposalRequest,
    owner: CmsAgentOwner,
    ctx: RequestContext
  ): Promise<ApiProfileCmsAgentProposal> {
    return this.ownerProposal(id, owner, ctx, async (proposal, tx) => {
      if (
        body.expected_draft_id !== proposal.draft_id ||
        body.expected_base_package_hash !== proposal.base_package_hash ||
        body.expected_candidate_package_hash !== proposal.candidate_package_hash
      )
        this.stale();
      if (proposal.status !== 'pending') {
        if (
          proposal.status !== body.status ||
          proposal.result_draft_id !== (body.result_draft_id ?? null) ||
          proposal.result_package_hash !== (body.result_package_hash ?? null)
        ) {
          fail(
            409,
            'cms_agent_review_conflict',
            'The proposal already has a different final decision'
          );
        }
        return this.toProposal(proposal);
      }
      if (body.status === 'applied')
        await this.assertSavedResult(proposal, body, tx);
      const reviewed: ProfileCmsAgentProposalEntity = {
        ...proposal,
        status: body.status,
        reviewed_at: this.now(),
        result_draft_id: body.result_draft_id ?? null,
        result_package_hash: body.result_package_hash ?? null
      };
      await this.grants.recordReview(reviewed, tx);
      await this.grants.insertEvent(
        {
          id: randomUUID(),
          profile_id: proposal.profile_id,
          grant_id: proposal.grant_id,
          proposal_id: proposal.id,
          event_type: body.status,
          actor_wallet: owner.wallet.toLowerCase(),
          created_at: this.now()
        },
        tx
      );
      return this.toProposal(reviewed);
    });
  }

  private async ownerProposal<T>(
    id: string,
    owner: CmsAgentOwner,
    ctx: RequestContext,
    action: (
      proposal: ProfileCmsAgentProposalEntity,
      tx: RequestContext
    ) => Promise<T>
  ): Promise<T> {
    const existing = await this.grants.findProposal(id, ctx);
    if (!existing)
      fail(404, 'cms_agent_unavailable', 'CMS agent proposal is unavailable');
    return this.ownerDraft(
      existing.draft_id,
      owner,
      ctx,
      async (_draft, tx) => {
        const proposal = await this.grants.findProposal(id, tx, true);
        if (!proposal || proposal.profile_id !== existing.profile_id)
          fail(
            404,
            'cms_agent_unavailable',
            'CMS agent proposal is unavailable'
          );
        return action(proposal, tx);
      }
    );
  }

  private async assertSavedResult(
    proposal: ProfileCmsAgentProposalEntity,
    body: ApiReviewProfileCmsAgentProposalRequest,
    ctx: RequestContext
  ): Promise<void> {
    if (
      !body.result_draft_id ||
      body.result_draft_id === proposal.draft_id ||
      body.result_package_hash !== proposal.candidate_package_hash
    )
      this.savedResultMismatch();
    const result = await this.packages.findByIdForUpdate(
      body.result_draft_id,
      ctx
    );
    const candidate = cmsPackageSchema.parse(proposal.candidate_package);
    if (
      !result ||
      result.profile_id !== proposal.profile_id ||
      result.package_id !== candidate.package_id ||
      result.status !== ProfileCmsPackageStatus.DRAFT ||
      result.version <= proposal.base_version ||
      result.created_at < proposal.created_at ||
      result.package_hash !== proposal.candidate_package_hash ||
      computeCmsPackageHash(cmsPackageSchema.parse(result.cms_package)) !==
        proposal.candidate_package_hash
    )
      this.savedResultMismatch();
  }
  private savedResultMismatch(): never {
    return fail(
      409,
      'cms_agent_saved_result_mismatch',
      'Save the exact reviewed candidate as a new draft before recording it as applied'
    );
  }

  private async ownerDraft<T>(
    draftId: string,
    owner: CmsAgentOwner,
    ctx: RequestContext,
    action: (
      draft: ProfileCmsPackageEntity,
      tx: RequestContext,
      handle: string
    ) => Promise<T>
  ): Promise<T> {
    const existing = await this.packages.findById(draftId, ctx);
    if (!existing)
      fail(404, 'cms_agent_unavailable', 'CMS draft is unavailable');
    return this.grants.executeNativeQueriesInTransaction(async (connection) => {
      const tx = { ...ctx, connection };
      const handle = await this.packages.lockProfilePackagesForUpdate(
        existing.profile_id,
        tx
      );
      await this.assertOwner(owner, existing.profile_id, tx);
      const draft = await this.packages.findByIdForUpdate(draftId, tx);
      if (!draft || draft.profile_id !== existing.profile_id)
        fail(404, 'cms_agent_unavailable', 'CMS draft is unavailable');
      return action(draft, tx, handle);
    });
  }

  private async withGrant<T>(
    token: string,
    ctx: RequestContext,
    action: (
      grant: ProfileCmsAgentGrantEntity,
      draft: ProfileCmsPackageEntity,
      tx: RequestContext
    ) => Promise<T>
  ): Promise<T> {
    enabled();
    const parsed = parseToken(token);
    const initial = await this.grants.findGrant(parsed.id, ctx);
    if (!matches(initial, parsed.secret)) return invalidGrant();
    const result = await this.grants.executeNativeQueriesInTransaction(
      async (connection) => {
        const tx = { ...ctx, connection };
        const handle = await this.packages.lockProfilePackagesForUpdate(
          initial.profile_id,
          tx
        );
        const grant = await this.grants.findGrant(parsed.id, tx, true);
        if (
          !matches(grant, parsed.secret) ||
          grant.revoked_at !== null ||
          grant.expires_at <= this.now()
        )
          return invalidGrant();
        if (
          !(await this.grants.walletOwnsProfile(
            grant.issued_by_wallet,
            grant.profile_id,
            tx
          ))
        )
          return invalidGrant();
        const draft = await this.packages.findByIdForUpdate(grant.draft_id, tx);
        if (
          !draft ||
          draft.profile_id !== grant.profile_id ||
          draft.package_id !== grant.package_id ||
          draft.version !== grant.base_version ||
          draft.package_hash !== grant.base_package_hash ||
          draft.profile_handle !== handle
        )
          this.stale();
        this.assertDraft(draft);
        if (grant.request_count >= CMS_AGENT_LIMITS.requests) quota();
        await this.grants.consumeRequest(grant.id, tx);
        try {
          return {
            value: await action(
              { ...grant, request_count: grant.request_count + 1 },
              draft,
              tx
            )
          };
        } catch (error) {
          // Charge authenticated invalid attempts too. Database failures still roll back and fail closed.
          if (error instanceof ApiCompliantException) return { error };
          throw error;
        }
      }
    );
    if ('error' in result) throw result.error;
    return result.value;
  }

  private async assertOwner(
    owner: CmsAgentOwner,
    profileId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (
      (owner.role && owner.role !== profileId) ||
      !(await this.grants.walletOwnsProfile(
        owner.wallet.toLowerCase(),
        profileId,
        ctx
      ))
    ) {
      fail(
        403,
        'cms_agent_owner_required',
        'Only the current profile owner can manage agent access'
      );
    }
  }
  private assertDraft(draft: ProfileCmsPackageEntity): void {
    if (draft.status !== ProfileCmsPackageStatus.DRAFT) this.stale();
  }
  private stale(): never {
    return fail(
      409,
      'cms_agent_base_changed',
      'The selected draft is no longer available as this proposal base'
    );
  }
  private async event(
    grant: ProfileCmsAgentGrantEntity,
    type: 'issued' | 'revoked' | 'proposed',
    proposalId: string | null,
    ctx: RequestContext,
    actorWallet: string | null = null
  ): Promise<void> {
    await this.grants.insertEvent(
      {
        id: randomUUID(),
        profile_id: grant.profile_id,
        grant_id: grant.id,
        proposal_id: proposalId,
        event_type: type,
        actor_wallet: actorWallet?.toLowerCase() ?? null,
        created_at: this.now()
      },
      ctx
    );
  }
  private toGrant(row: ProfileCmsAgentGrantEntity): ApiProfileCmsAgentGrant {
    return {
      id: row.id,
      profile_id: row.profile_id,
      draft_id: row.draft_id,
      package_id: row.package_id,
      base_version: row.base_version,
      base_package_hash: row.base_package_hash,
      label: row.label,
      created_at: row.created_at,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      requests_remaining: Math.max(
        0,
        CMS_AGENT_LIMITS.requests - row.request_count
      ),
      proposals_remaining: Math.max(
        0,
        CMS_AGENT_LIMITS.proposals - row.proposal_count
      )
    };
  }
  private toProposal(
    row: ProfileCmsAgentProposalEntity
  ): ApiProfileCmsAgentProposal {
    return {
      ...this.toProposalSummary(row),
      status: row.status as ApiProfileCmsAgentProposalStatusEnum,
      candidate_package: { ...cmsPackageSchema.parse(row.candidate_package) }
    };
  }
  private toProposalSummary(
    row: CmsAgentProposalSummary
  ): ApiProfileCmsAgentProposalSummary {
    return {
      id: row.id,
      grant_id: row.grant_id,
      profile_id: row.profile_id,
      draft_id: row.draft_id,
      base_version: row.base_version,
      base_package_hash: row.base_package_hash,
      candidate_package_hash: row.candidate_package_hash,
      summary: row.summary,
      created_at: row.created_at,
      status: row.status as ApiProfileCmsAgentProposalSummaryStatusEnum,
      reviewed_at: row.reviewed_at,
      result_draft_id: row.result_draft_id,
      result_package_hash: row.result_package_hash
    };
  }
}

export const profileCmsAgentApiService = new ProfileCmsAgentApiService(
  profileCmsAgentGrantsDb,
  profileCmsPackagesDb
);
