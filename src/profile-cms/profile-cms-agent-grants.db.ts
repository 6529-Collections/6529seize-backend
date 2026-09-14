import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILE_CMS_AGENT_EVENTS_TABLE,
  PROFILE_CMS_AGENT_GRANTS_TABLE,
  PROFILE_CMS_AGENT_PROPOSALS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { ProfileCmsAgentGrantEntity } from '@/entities/IProfileCmsAgentGrant';
import { ProfileCmsAgentProposalEntity } from '@/entities/IProfileCmsAgentProposal';
import { ProfileCmsAgentEventEntity } from '@/entities/IProfileCmsAgentEvent';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type CmsAgentProposalSummary = Omit<
  ProfileCmsAgentProposalEntity,
  'candidate_package' | 'idempotency_key' | 'request_hash'
>;

export class ProfileCmsAgentGrantsDb extends LazyDbAccessCompatibleService {
  async walletOwnsProfile(
    wallet: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const rows = await this.query<{ profile_id: string }>(
      'walletOwnsProfile',
      `select i.profile_id from ${IDENTITIES_TABLE} i
       join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
       where a.address = :wallet and i.profile_id = :profileId limit 1`,
      { wallet, profileId },
      ctx
    );
    return rows.length === 1;
  }

  async findGrant(
    id: string,
    ctx: RequestContext,
    lock = false
  ): Promise<ProfileCmsAgentGrantEntity | null> {
    const rows = await this.query<ProfileCmsAgentGrantEntity>(
      'findGrant',
      `select * from ${PROFILE_CMS_AGENT_GRANTS_TABLE} where id = :id${lock ? ' for update' : ''}`,
      { id },
      ctx
    );
    return rows[0] ?? null;
  }

  async insertGrant(
    grant: ProfileCmsAgentGrantEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.query(
      'insertGrant',
      `insert into ${PROFILE_CMS_AGENT_GRANTS_TABLE}
      (id, profile_id, draft_id, package_id, base_version, base_package_hash, issued_by_wallet,
       token_hash, label, created_at, expires_at, revoked_at, request_count, proposal_count)
      values (:id, :profile_id, :draft_id, :package_id, :base_version, :base_package_hash,
       :issued_by_wallet, :token_hash, :label, :created_at, :expires_at, :revoked_at, :request_count, :proposal_count)`,
      { ...grant },
      ctx
    );
  }

  async grantQuota(
    profileId: string,
    now: number,
    ctx: RequestContext
  ): Promise<{ active: number; daily: number }> {
    const rows = await this.query<{ active: number; daily: number }>(
      'grantQuota',
      `select coalesce(sum(revoked_at is null and expires_at > :now), 0) as active,
       coalesce(sum(created_at > :since), 0) as daily from ${PROFILE_CMS_AGENT_GRANTS_TABLE}
       where profile_id = :profileId`,
      { profileId, now, since: now - 86400000 },
      ctx
    );
    return rows[0];
  }

  async revoke(id: string, now: number, ctx: RequestContext): Promise<void> {
    await this.query(
      'revoke',
      `update ${PROFILE_CMS_AGENT_GRANTS_TABLE}
      set revoked_at = :now where id = :id and revoked_at is null`,
      { id, now },
      ctx
    );
  }

  async consumeRequest(id: string, ctx: RequestContext): Promise<void> {
    await this.query(
      'consumeRequest',
      `update ${PROFILE_CMS_AGENT_GRANTS_TABLE}
      set request_count = request_count + 1 where id = :id`,
      { id },
      ctx
    );
  }

  async listGrants(
    draftId: string,
    limit: number,
    offset: number,
    ctx: RequestContext
  ): Promise<ProfileCmsAgentGrantEntity[]> {
    return this.query(
      'listGrants',
      `select * from ${PROFILE_CMS_AGENT_GRANTS_TABLE}
      where draft_id = :draftId order by created_at desc, id desc limit :limit offset :offset`,
      { draftId, limit, offset },
      ctx
    );
  }

  async findProposal(
    id: string,
    ctx: RequestContext,
    lock = false
  ): Promise<ProfileCmsAgentProposalEntity | null> {
    const rows = await this.query<ProfileCmsAgentProposalEntity>(
      'findProposal',
      `select * from ${PROFILE_CMS_AGENT_PROPOSALS_TABLE} where id = :id${lock ? ' for update' : ''}`,
      { id },
      ctx
    );
    return this.hydrate(rows[0]);
  }

  async findIdempotent(
    grantId: string,
    key: string,
    ctx: RequestContext
  ): Promise<ProfileCmsAgentProposalEntity | null> {
    const rows = await this.query<ProfileCmsAgentProposalEntity>(
      'findIdempotent',
      `select * from ${PROFILE_CMS_AGENT_PROPOSALS_TABLE} where grant_id = :grantId and idempotency_key = :key`,
      { grantId, key },
      ctx
    );
    return this.hydrate(rows[0]);
  }

  async proposalCount(
    profileId: string,
    since: number,
    ctx: RequestContext
  ): Promise<number> {
    const rows = await this.query<{ count: number }>(
      'proposalCount',
      `select count(*) as count from ${PROFILE_CMS_AGENT_PROPOSALS_TABLE}
       where profile_id = :profileId and created_at > :since`,
      { profileId, since },
      ctx
    );
    return rows[0].count;
  }

  async insertProposal(
    proposal: ProfileCmsAgentProposalEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.query(
      'insertProposal',
      `insert into ${PROFILE_CMS_AGENT_PROPOSALS_TABLE}
      (id, grant_id, profile_id, draft_id, base_version, base_package_hash, candidate_package_hash,
       idempotency_key, request_hash, summary, created_at, candidate_package,
       status, reviewed_at, result_draft_id, result_package_hash)
      values (:id, :grant_id, :profile_id, :draft_id, :base_version, :base_package_hash,
       :candidate_package_hash, :idempotency_key, :request_hash, :summary, :created_at, :candidate_package,
       :status, :reviewed_at, :result_draft_id, :result_package_hash)`,
      {
        ...proposal,
        candidate_package: JSON.stringify(proposal.candidate_package)
      },
      ctx
    );
    await this.query(
      'consumeProposal',
      `update ${PROFILE_CMS_AGENT_GRANTS_TABLE}
      set proposal_count = proposal_count + 1 where id = :id`,
      { id: proposal.grant_id },
      ctx
    );
  }

  async listProposals(
    draftId: string,
    limit: number,
    offset: number,
    ctx: RequestContext
  ): Promise<CmsAgentProposalSummary[]> {
    return this.query<CmsAgentProposalSummary>(
      'listProposals',
      `select id, grant_id, profile_id, draft_id, base_version, base_package_hash,
       candidate_package_hash, summary, created_at, status, reviewed_at, result_draft_id,
       result_package_hash from ${PROFILE_CMS_AGENT_PROPOSALS_TABLE} where draft_id = :draftId
       order by created_at desc, id desc limit :limit offset :offset`,
      { draftId, limit, offset },
      ctx
    );
  }

  async insertEvent(
    event: ProfileCmsAgentEventEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.query(
      'insertEvent',
      `insert into ${PROFILE_CMS_AGENT_EVENTS_TABLE}
      (id, profile_id, grant_id, proposal_id, event_type, actor_wallet, created_at)
      values (:id, :profile_id, :grant_id, :proposal_id, :event_type, :actor_wallet, :created_at)`,
      { ...event },
      ctx
    );
  }

  async recordReview(
    proposal: ProfileCmsAgentProposalEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.query(
      'recordReview',
      `update ${PROFILE_CMS_AGENT_PROPOSALS_TABLE}
      set status = :status, reviewed_at = :reviewed_at, result_draft_id = :result_draft_id,
      result_package_hash = :result_package_hash where id = :id and status = 'pending'`,
      {
        id: proposal.id,
        status: proposal.status,
        reviewed_at: proposal.reviewed_at,
        result_draft_id: proposal.result_draft_id,
        result_package_hash: proposal.result_package_hash
      },
      ctx
    );
  }

  private hydrate(
    row: ProfileCmsAgentProposalEntity | undefined
  ): ProfileCmsAgentProposalEntity | null {
    if (!row) return null;
    return {
      ...row,
      candidate_package:
        typeof row.candidate_package === 'string'
          ? (JSON.parse(row.candidate_package) as unknown)
          : row.candidate_package
    };
  }

  private async query<T>(
    method: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${method}`;
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(
        sql,
        params,
        ctx.connection
          ? { wrappedConnection: ctx.connection }
          : { forcePool: DbPoolName.WRITE }
      );
    } finally {
      ctx.timer?.stop(name);
    }
  }
}

export const profileCmsAgentGrantsDb = new ProfileCmsAgentGrantsDb(dbSupplier);
