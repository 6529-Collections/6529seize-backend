import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ProfileCmsAgentApiService,
  CMS_AGENT_LIMITS
} from './profile-cms-agent.api.service';
import { ProfileCmsAgentGrantsDb } from '@/profile-cms/profile-cms-agent-grants.db';
import { ProfileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { ProfileCmsAgentGrantEntity } from '@/entities/IProfileCmsAgentGrant';
import { ProfileCmsAgentProposalEntity } from '@/entities/IProfileCmsAgentProposal';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('draft-scoped CMS proposal capabilities', () => {
  const base = createValidProfileCmsPackage();
  const owner = {
    wallet: base.profile.primary_wallet!.toLowerCase(),
    role: null
  };
  let now: number;
  let grants: Map<string, ProfileCmsAgentGrantEntity>;
  let proposals: Map<string, ProfileCmsAgentProposalEntity>;
  let draft: ProfileCmsPackageEntity;
  let repository: jest.Mocked<
    Pick<
      ProfileCmsAgentGrantsDb,
      | 'findGrant'
      | 'insertGrant'
      | 'grantQuota'
      | 'walletOwnsProfile'
      | 'revoke'
      | 'consumeRequest'
      | 'findIdempotent'
      | 'proposalCount'
      | 'insertProposal'
      | 'findProposal'
      | 'listGrants'
      | 'listProposals'
      | 'insertEvent'
      | 'recordReview'
      | 'executeNativeQueriesInTransaction'
    >
  >;
  let packages: jest.Mocked<
    Pick<
      ProfileCmsPackagesDb,
      'findById' | 'findByIdForUpdate' | 'lockProfilePackagesForUpdate'
    >
  >;
  let service: ProfileCmsAgentApiService;
  let queue: Promise<unknown>;

  beforeEach(() => {
    now = 1000;
    grants = new Map();
    proposals = new Map();
    queue = Promise.resolve();
    draft = {
      id: 'saved-draft',
      profile_id: base.profile.profile_id!,
      profile_handle: base.profile.handle,
      package_id: base.package_id,
      version: 3,
      package_hash: base.integrity.package_hash,
      status: ProfileCmsPackageStatus.DRAFT,
      cms_package: clone(base)
    } as ProfileCmsPackageEntity;
    repository = {
      findGrant: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['findGrant']>,
        Parameters<ProfileCmsAgentGrantsDb['findGrant']>
      >(async (id) => grants.get(id) ?? null),
      insertGrant: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['insertGrant']>,
        Parameters<ProfileCmsAgentGrantsDb['insertGrant']>
      >(async (grant) => {
        grants.set(grant.id, grant);
      }),
      grantQuota: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['grantQuota']>,
        Parameters<ProfileCmsAgentGrantsDb['grantQuota']>
      >(async () => ({ active: grants.size, daily: grants.size })),
      walletOwnsProfile: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['walletOwnsProfile']>,
        Parameters<ProfileCmsAgentGrantsDb['walletOwnsProfile']>
      >(async (wallet) => wallet === owner.wallet),
      revoke: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['revoke']>,
        Parameters<ProfileCmsAgentGrantsDb['revoke']>
      >(async (id, at) => {
        grants.set(id, { ...grants.get(id)!, revoked_at: at });
      }),
      consumeRequest: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['consumeRequest']>,
        Parameters<ProfileCmsAgentGrantsDb['consumeRequest']>
      >(async (id) => {
        const grant = grants.get(id)!;
        grants.set(id, { ...grant, request_count: grant.request_count + 1 });
      }),
      findIdempotent: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['findIdempotent']>,
        Parameters<ProfileCmsAgentGrantsDb['findIdempotent']>
      >(
        async (id, key) =>
          Array.from(proposals.values()).find(
            (row) => row.grant_id === id && row.idempotency_key === key
          ) ?? null
      ),
      proposalCount: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['proposalCount']>,
        Parameters<ProfileCmsAgentGrantsDb['proposalCount']>
      >(async () => proposals.size),
      insertProposal: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['insertProposal']>,
        Parameters<ProfileCmsAgentGrantsDb['insertProposal']>
      >(async (proposal) => {
        proposals.set(proposal.id, proposal);
        const grant = grants.get(proposal.grant_id)!;
        grants.set(grant.id, {
          ...grant,
          proposal_count: grant.proposal_count + 1
        });
      }),
      findProposal: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['findProposal']>,
        Parameters<ProfileCmsAgentGrantsDb['findProposal']>
      >(async (id) => proposals.get(id) ?? null),
      listGrants: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['listGrants']>,
        Parameters<ProfileCmsAgentGrantsDb['listGrants']>
      >(async () => Array.from(grants.values())),
      listProposals: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['listProposals']>,
        Parameters<ProfileCmsAgentGrantsDb['listProposals']>
      >(async () => Array.from(proposals.values())),
      recordReview: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['recordReview']>,
        Parameters<ProfileCmsAgentGrantsDb['recordReview']>
      >(async (row) => {
        proposals.set(row.id, row);
      }),
      insertEvent: jest.fn<
        ReturnType<ProfileCmsAgentGrantsDb['insertEvent']>,
        Parameters<ProfileCmsAgentGrantsDb['insertEvent']>
      >(async () => {}),
      executeNativeQueriesInTransaction: jest.fn()
    };
    repository.executeNativeQueriesInTransaction.mockImplementation(
      (action) => {
        const next = queue.then(() => action({ connection: {} }));
        queue = next.catch(() => {});
        return next;
      }
    );
    packages = {
      findById: jest.fn<
        ReturnType<ProfileCmsPackagesDb['findById']>,
        Parameters<ProfileCmsPackagesDb['findById']>
      >(async () => draft),
      findByIdForUpdate: jest.fn<
        ReturnType<ProfileCmsPackagesDb['findByIdForUpdate']>,
        Parameters<ProfileCmsPackagesDb['findByIdForUpdate']>
      >(async () => draft),
      lockProfilePackagesForUpdate: jest.fn<
        ReturnType<ProfileCmsPackagesDb['lockProfilePackagesForUpdate']>,
        Parameters<ProfileCmsPackagesDb['lockProfilePackagesForUpdate']>
      >(async () => base.profile.handle)
    };
    service = new ProfileCmsAgentApiService(
      repository as unknown as ProfileCmsAgentGrantsDb,
      packages as unknown as ProfileCmsPackagesDb,
      () => now
    );
    delete process.env.FEATURE_PROFILE_CMS_AGENT_PROPOSALS;
  });
  afterEach(() => {
    delete process.env.FEATURE_PROFILE_CMS_AGENT_PROPOSALS;
  });
  const issue = () =>
    service.issue(
      'saved-draft',
      { label: 'My agent', expected_package_hash: base.integrity.package_hash },
      owner,
      {}
    );
  const body = () => ({
    draft_id: 'saved-draft',
    base_version: 3,
    base_package_hash: base.integrity.package_hash,
    candidate_package: {
      ...clone(base),
      site: { ...base.site, title: 'Proposed title' }
    },
    summary: 'Improve the title',
    idempotency_key: randomUUID()
  });

  it('shows the token once, stores only its digest, and binds reads to a writer-checked owner and base', async () => {
    const result = await issue();
    const stored = grants.get(result.grant.id)!;
    expect(result.token).toMatch(/^cms_agent_[a-f0-9-]{36}\.[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(result.token.split('.')[1]);
    const read = await service.readDraft(result.token, {});
    expect(read.grant).toMatchObject({
      draft_id: 'saved-draft',
      base_version: 3,
      requests_remaining: 199
    });
    expect(read.grant).not.toHaveProperty('token_hash');
    expect(read.cms_package).toEqual(base);
    expect(repository.walletOwnsProfile).toHaveBeenLastCalledWith(
      owner.wallet,
      draft.profile_id,
      expect.objectContaining({ connection: expect.anything() })
    );
  });

  it.each(['expired', 'revoked', 'detached', 'bad-secret', 'website-jwt'])(
    'rejects %s credentials',
    async (kind) => {
      const issued = await issue();
      let token = issued.token;
      if (kind === 'expired') now = issued.grant.expires_at;
      if (kind === 'revoked') await service.revoke(issued.grant.id, owner, {});
      if (kind === 'detached')
        repository.walletOwnsProfile.mockResolvedValue(false);
      if (kind === 'bad-secret') token = token.slice(0, -64) + '0'.repeat(64);
      if (kind === 'website-jwt')
        token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
      await expect(service.readDraft(token, {})).rejects.toMatchObject({
        code: 'cms_agent_invalid_grant'
      });
      expect(repository.consumeRequest).not.toHaveBeenCalled();
    }
  );

  it.each(['profile', 'version', 'hash', 'package', 'handle', 'published'])(
    'rejects a changed %s base',
    async (kind) => {
      const issued = await issue();
      if (kind === 'profile')
        draft = { ...draft, profile_id: 'another-profile' };
      if (kind === 'version') draft = { ...draft, version: 4 };
      if (kind === 'hash')
        draft = { ...draft, package_hash: `sha256:${'a'.repeat(64)}` };
      if (kind === 'package')
        draft = { ...draft, package_id: 'another-package' };
      if (kind === 'handle')
        packages.lockProfilePackagesForUpdate.mockResolvedValue('Renamed');
      if (kind === 'published')
        draft = { ...draft, status: ProfileCmsPackageStatus.PUBLISHED };
      await expect(service.readDraft(issued.token, {})).rejects.toMatchObject({
        code: 'cms_agent_base_changed'
      });
    }
  );

  it('rejects proxy issuance and an owner detached since wallet authentication', async () => {
    await expect(
      service.issue(
        draft.id,
        { label: 'No', expected_package_hash: draft.package_hash },
        { ...owner, role: 'another-profile' },
        {}
      )
    ).rejects.toMatchObject({ code: 'cms_agent_owner_required' });
    repository.walletOwnsProfile.mockResolvedValue(false);
    await expect(issue()).rejects.toMatchObject({
      code: 'cms_agent_owner_required'
    });
    expect(repository.insertGrant).not.toHaveBeenCalled();
  });

  it('serializes idempotent submissions and never overwrites the saved package', async () => {
    const issued = await issue();
    const input = body();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.submit(issued.token, input, {}))
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(repository.insertProposal).toHaveBeenCalledTimes(1);
    expect(draft.cms_package).toEqual(base);
    expect(results[0].candidate_package_hash).not.toBe(
      base.integrity.package_hash
    );
    await expect(
      service.submit(issued.token, { ...input, summary: 'Changed' }, {})
    ).rejects.toMatchObject({ code: 'cms_agent_idempotency_conflict' });
  });

  it('does not let one grant read another grant proposal', async () => {
    const first = await issue();
    const second = await issue();
    const proposal = await service.submit(first.token, body(), {});
    await expect(
      service.readProposal(second.token, proposal.id, {})
    ).rejects.toMatchObject({ code: 'cms_agent_unavailable' });
  });

  it('checks revocation again after the initial lookup', async () => {
    const issued = await issue();
    const original = grants.get(issued.grant.id)!;
    repository.findGrant
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, revoked_at: now });
    await expect(service.readDraft(issued.token, {})).rejects.toMatchObject({
      code: 'cms_agent_invalid_grant'
    });
  });

  it('fails closed on durable quota errors and request exhaustion', async () => {
    const issued = await issue();
    repository.proposalCount.mockRejectedValue(
      new Error('database unavailable')
    );
    await expect(service.submit(issued.token, body(), {})).rejects.toThrow(
      'database unavailable'
    );
    expect(repository.insertProposal).not.toHaveBeenCalled();
    grants.set(issued.grant.id, {
      ...grants.get(issued.grant.id)!,
      request_count: CMS_AGENT_LIMITS.requests
    });
    await expect(service.readDraft(issued.token, {})).rejects.toMatchObject({
      code: 'cms_agent_quota_exhausted'
    });
  });

  it('allows owner revocation while the feature is disabled', async () => {
    const issued = await issue();
    process.env.FEATURE_PROFILE_CMS_AGENT_PROPOSALS = 'false';
    await expect(service.readDraft(issued.token, {})).rejects.toMatchObject({
      code: 'cms_agent_disabled'
    });
    await expect(
      service.revoke(issued.grant.id, owner, {})
    ).resolves.toMatchObject({ revoked_at: now });
  });
});
