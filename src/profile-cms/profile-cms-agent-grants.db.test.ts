import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { sqlExecutor } from '@/sql-executor';
import { ProfileCmsAgentApiService } from '@/api/profile-cms/profile-cms-agent.api.service';
import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import type { IdentityFetcher } from '@/api/identities/identity.fetcher';
import type { ProfileCmsPointerEventsDb } from './profile-cms-pointer-events.db';
import type { ProfileCmsPublishSignaturesDb } from './profile-cms-publish-signatures.db';
import type { ProfileCmsStorageReceiptVerifier } from './profile-cms-storage';
import { AuthenticationContext } from '@/auth-context';
import {
  ProfileCmsPackagesDb,
  NewProfileCmsPackageEntity
} from './profile-cms-packages.db';
import { ProfileCmsAgentGrantsDb } from './profile-cms-agent-grants.db';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { withAddressConsolidationKeys } from '@/tests/fixtures/address-consolidation-key.fixture';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';
import {
  PROFILE_CMS_AGENT_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  PROFILE_CMS_AGENT_GRANTS_TABLE
} from '@/constants';
import { ApiReviewProfileCmsAgentProposalRequestStatusEnum } from '@/api/generated/models/ApiReviewProfileCmsAgentProposalRequest';

const profileId = 'cms-agent-transaction-test';
const base = createValidProfileCmsPackage({
  handle: 'CmsAgentTests',
  profileId
});
const owner = {
  wallet: base.profile.primary_wallet!.toLowerCase(),
  role: null
};
const packages = new ProfileCmsPackagesDb(() => sqlExecutor);
const grants = new ProfileCmsAgentGrantsDb(() => sqlExecutor);
const service = new ProfileCmsAgentApiService(grants, packages);
const draftService = new ProfileCmsApiService(
  packages,
  {
    getIdentityAndConsolidationsByIdentityKey: async () => ({
      id: profileId,
      handle: base.profile.handle,
      primary_wallet: owner.wallet,
      wallets: [{ wallet: owner.wallet }]
    })
  } as unknown as IdentityFetcher,
  {} as ProfileCmsPointerEventsDb,
  {} as ProfileCmsPublishSignaturesDb,
  {} as ProfileCmsStorageReceiptVerifier
);

function makeDraft(
  version: number,
  cmsPackage = base
): NewProfileCmsPackageEntity {
  return {
    id: randomUUID(),
    profile_id: profileId,
    profile_handle: base.profile.handle,
    package_id: base.package_id,
    version,
    status: ProfileCmsPackageStatus.DRAFT,
    cms_package: cmsPackage,
    payload_hash: cmsPackage.integrity.payload_hash,
    package_hash: cmsPackage.integrity.package_hash,
    primary_path: cmsPackage.site.base_path,
    is_primary: false,
    production_valid: false,
    created_by_profile_id: profileId,
    published_by_profile_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: cmsPackage.storage,
    storage_provider: null,
    storage_uri: null,
    storage_content_hash: null,
    storage_provider_content_id: null,
    storage_recorded_at: null,
    storage_pinned: null,
    storage_canonical: null
  };
}

describeWithSeed(
  'CMS agent grant transactions',
  [
    withProfiles([
      aProfile({
        external_id: profileId,
        handle: base.profile.handle,
        primary_wallet: owner.wallet
      })
    ]),
    withIdentities([
      anIdentity(
        {},
        {
          consolidation_key: owner.wallet,
          profile_id: profileId,
          primary_address: owner.wallet,
          handle: base.profile.handle
        }
      )
    ]),
    withAddressConsolidationKeys([
      { address: owner.wallet, consolidation_key: owner.wallet }
    ])
  ],
  () => {
    async function prepare() {
      const draft = await packages.insert(makeDraft(1), {});
      const issued = await service.issue(
        draft.id,
        { label: 'Test agent', expected_package_hash: draft.package_hash },
        owner,
        {}
      );
      return { draft, ...issued };
    }
    const candidate = (draftId: string) => ({
      draft_id: draftId,
      base_version: 1,
      base_package_hash: base.integrity.package_hash,
      candidate_package: {
        ...base,
        site: { ...base.site, title: 'Reviewed full website' }
      },
      summary: 'Revise the website title',
      idempotency_key: randomUUID()
    });

    it('enforces the active-grant quota during simultaneous issuance', async () => {
      const draft = await packages.insert(makeDraft(1), {});
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          service.issue(
            draft.id,
            {
              label: 'Concurrent agent',
              expected_package_hash: draft.package_hash
            },
            owner,
            {}
          )
        )
      );
      expect(
        outcomes.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(5);
      const rejected = outcomes.filter(
        (result) => result.status === 'rejected'
      );
      expect(rejected).toHaveLength(3);
      rejected.forEach((result) => {
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({
            code: 'cms_agent_quota_exhausted'
          });
      });
      expect(await grants.listGrants(draft.id, 50, 0, {})).toHaveLength(5);
    });

    it('stores one immutable proposal and audit event for concurrent identical submissions', async () => {
      const { draft, token, grant } = await prepare();
      const input = candidate(draft.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => service.submit(token, input, {}))
      );
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(await grants.listProposals(draft.id, 50, 0, {})).toHaveLength(1);
      expect(await grants.findGrant(grant.id, {})).toMatchObject({
        request_count: 8,
        proposal_count: 1
      });
      expect(await packages.findById(draft.id, {})).toMatchObject({
        package_hash: base.integrity.package_hash
      });
      const events = await sqlExecutor.execute<{ event_type: string }>(
        `select event_type from ${PROFILE_CMS_AGENT_EVENTS_TABLE} where grant_id = :id`,
        { id: grant.id }
      );
      expect(
        events.filter((event) => event.event_type === 'proposed')
      ).toHaveLength(1);
      await expect(
        service.submit(token, { ...input, summary: 'Different content' }, {})
      ).rejects.toMatchObject({ code: 'cms_agent_idempotency_conflict' });
    });

    it('immediately rejects revoked grants and detached issuing wallets, with owner review retained', async () => {
      const { draft, token, grant } = await prepare();
      const proposal = await service.submit(token, candidate(draft.id), {});
      await service.revoke(grant.id, owner, {});
      await expect(service.readDraft(token, {})).rejects.toMatchObject({
        code: 'cms_agent_invalid_grant'
      });
      expect(
        await service.readOwnerProposal(proposal.id, owner, {})
      ).toMatchObject({ id: proposal.id, status: 'pending' });
      const replacement = await service.issue(
        draft.id,
        { label: 'Replacement', expected_package_hash: draft.package_hash },
        owner,
        {}
      );
      await sqlExecutor.execute(
        `delete from ${ADDRESS_CONSOLIDATION_KEY} where address = :wallet`,
        { wallet: owner.wallet }
      );
      await expect(
        service.readDraft(replacement.token, {})
      ).rejects.toMatchObject({ code: 'cms_agent_invalid_grant' });
    });

    it('retains owner-only rejection after revocation without changing draft content', async () => {
      const { draft, token, grant } = await prepare();
      const proposal = await service.submit(token, candidate(draft.id), {});
      await service.revoke(grant.id, owner, {});
      const request = {
        status: ApiReviewProfileCmsAgentProposalRequestStatusEnum.Rejected,
        expected_draft_id: draft.id,
        expected_base_package_hash: draft.package_hash,
        expected_candidate_package_hash: proposal.candidate_package_hash
      };
      const outsider = { wallet: `0x${'2'.repeat(40)}`, role: null };
      await expect(
        service.readOwnerProposal(proposal.id, outsider, {})
      ).rejects.toMatchObject({ code: 'cms_agent_owner_required' });
      await expect(
        service.reviewProposal(proposal.id, request, outsider, {})
      ).rejects.toMatchObject({ code: 'cms_agent_owner_required' });
      await expect(
        service.reviewProposal(
          proposal.id,
          {
            ...request,
            expected_base_package_hash: `sha256:${'0'.repeat(64)}`
          },
          owner,
          {}
        )
      ).rejects.toMatchObject({ code: 'cms_agent_base_changed' });
      const rejected = await service.reviewProposal(
        proposal.id,
        request,
        owner,
        {}
      );
      expect(rejected).toMatchObject({
        status: 'rejected',
        result_draft_id: null
      });
      expect(
        await service.reviewProposal(proposal.id, request, owner, {})
      ).toEqual(rejected);
      expect(await packages.findById(draft.id, {})).toMatchObject({
        status: ProfileCmsPackageStatus.DRAFT,
        package_hash: draft.package_hash
      });
      expect(await grants.listProposals(draft.id, 50, 0, {})).toHaveLength(1);
    });

    it('records applied only for a separately saved exact candidate and returns its disposition to the agent', async () => {
      const { draft, token } = await prepare();
      const proposal = await service.submit(token, candidate(draft.id), {});
      const request = {
        status: ApiReviewProfileCmsAgentProposalRequestStatusEnum.Applied,
        expected_draft_id: draft.id,
        expected_base_package_hash: draft.package_hash,
        expected_candidate_package_hash: proposal.candidate_package_hash,
        result_draft_id: draft.id,
        result_package_hash: proposal.candidate_package_hash
      };
      await expect(
        service.reviewProposal(proposal.id, request, owner, {})
      ).rejects.toMatchObject({ code: 'cms_agent_saved_result_mismatch' });
      const result = await draftService.saveDraft(
        { profile_id: profileId, cms_package: proposal.candidate_package },
        {
          authenticationContext: new AuthenticationContext({
            authenticatedWallet: owner.wallet,
            authenticatedProfileId: profileId,
            roleProfileId: null,
            activeProxyActions: []
          })
        }
      );
      expect(result.package_hash).toBe(proposal.candidate_package_hash);
      const applied = await service.reviewProposal(
        proposal.id,
        { ...request, result_draft_id: result.id },
        owner,
        {}
      );
      expect(applied).toMatchObject({
        status: 'applied',
        result_draft_id: result.id
      });
      expect(await service.readProposal(token, proposal.id, {})).toMatchObject({
        status: 'applied',
        result_draft_id: result.id
      });
      expect(
        await service.reviewProposal(
          proposal.id,
          { ...request, result_draft_id: result.id },
          owner,
          {}
        )
      ).toEqual(applied);
      await expect(
        service.reviewProposal(
          proposal.id,
          {
            status: ApiReviewProfileCmsAgentProposalRequestStatusEnum.Rejected,
            expected_draft_id: draft.id,
            expected_base_package_hash: draft.package_hash,
            expected_candidate_package_hash: proposal.candidate_package_hash
          },
          owner,
          {}
        )
      ).rejects.toMatchObject({ code: 'cms_agent_review_conflict' });
    });
    it('rolls back candidate, quota usage and audit when durable event recording fails', async () => {
      const { draft, token, grant } = await prepare();
      const input = candidate(draft.id);
      const failure = jest
        .spyOn(grants, 'insertEvent')
        .mockRejectedValueOnce(new Error('Simulated audit database failure'));
      try {
        await expect(service.submit(token, input, {})).rejects.toThrow(
          'Simulated audit database failure'
        );
      } finally {
        failure.mockRestore();
      }
      expect(await grants.listProposals(draft.id, 50, 0, {})).toEqual([]);
      expect(await grants.findGrant(grant.id, {})).toMatchObject({
        request_count: 0,
        proposal_count: 0
      });
      await expect(service.submit(token, input, {})).resolves.toMatchObject({
        status: 'pending'
      });
    });

    it('admits exactly the last remaining proposal slot under concurrency and lists no candidate bytes', async () => {
      const { draft, token, grant } = await prepare();
      await sqlExecutor.execute(
        `update ${PROFILE_CMS_AGENT_GRANTS_TABLE} set proposal_count = 19 where id = :id`,
        { id: grant.id }
      );
      const results = await Promise.allSettled([
        service.submit(token, candidate(draft.id), {}),
        service.submit(token, candidate(draft.id), {})
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected')
      ).toHaveLength(1);
      expect(await grants.findGrant(grant.id, {})).toMatchObject({
        proposal_count: 20
      });
      const summaries = await service.listProposals(draft.id, owner, 50, 0, {});
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).not.toHaveProperty('candidate_package');
      expect(await grants.listProposals(draft.id, 50, 0, {})).toEqual(
        summaries
      );
    });
  }
);
