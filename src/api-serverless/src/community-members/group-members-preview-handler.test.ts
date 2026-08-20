import { ApiGroupBeneficiaryGrantMatchMode } from '../generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupFilterDirection } from '../generated/models/ApiGroupFilterDirection';
import { ApiGroupTdhInclusionStrategy } from '../generated/models/ApiGroupTdhInclusionStrategy';
import { handlePreviewGroupMembers } from './group-members-preview.handler';
import { communityMembersService } from './community-members.service';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn().mockResolvedValue({
    actor: 'profile-1'
  })
}));

jest.mock('./community-members.service', () => ({
  communityMembersService: {
    getCommunityMembersPage: jest.fn()
  }
}));

const group = {
  tdh: {
    min: 10,
    max: null,
    inclusion_strategy: ApiGroupTdhInclusionStrategy.Both
  },
  rep: {
    min: null,
    max: null,
    direction: ApiGroupFilterDirection.Received,
    user_identity: null,
    category: null
  },
  cic: {
    min: null,
    max: null,
    direction: ApiGroupFilterDirection.Received,
    user_identity: null
  },
  level: { min: null, max: null },
  owns_nfts: [],
  identity_addresses: null,
  excluded_identity_addresses: null,
  is_beneficiary_of_grant_id: null,
  is_beneficiary_of_grant_match_mode: ApiGroupBeneficiaryGrantMatchMode.AnyToken
};

describe('handlePreviewGroupMembers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates the draft and requests a paginated read-only preview', async () => {
    const page = { data: [], page: 2, count: 0, next: false };
    jest
      .mocked(communityMembersService.getCommunityMembersPage)
      .mockResolvedValue(page);

    await expect(
      handlePreviewGroupMembers({
        body: { group },
        query: { page: 2, page_size: 20, param: 'alice' }
      } as never)
    ).resolves.toBe(page);

    expect(
      communityMembersService.getCommunityMembersPage
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        page_size: 20,
        group_id: null,
        param: 'alice'
      }),
      expect.objectContaining({
        authenticationContext: expect.objectContaining({ actor: 'profile-1' })
      }),
      expect.objectContaining({ tdh: expect.objectContaining({ min: 10 }) })
    );
  });

  it('rejects an invalid draft before evaluating membership', async () => {
    await expect(
      handlePreviewGroupMembers({ body: { group: {} }, query: {} } as never)
    ).rejects.toThrow();
    expect(
      communityMembersService.getCommunityMembersPage
    ).not.toHaveBeenCalled();
  });
});
