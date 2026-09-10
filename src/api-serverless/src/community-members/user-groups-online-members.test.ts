import { mock } from 'ts-jest-mocker';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { ApiGroupDescription } from '@/api/generated/models/ApiGroupDescription';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { ApiGroupBeneficiaryGrantMatchMode } from '@/api/generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupTdhInclusionStrategy } from '@/api/generated/models/ApiGroupTdhInclusionStrategy';
import { ApiGroupOwnsNftNameEnum } from '@/api/generated/models/ApiGroupOwnsNft';
import { ApiGroupNftOwnershipMatchMode } from '@/api/generated/models/ApiGroupNftOwnershipMatchMode';
import { NotFoundException } from '@/exceptions';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiGroupFilterDirection } from '@/api/generated/models/ApiGroupFilterDirection';

function levelZeroGroup(): ApiGroupDescription {
  return {
    cic: { min: null, max: null, user_identity: null, direction: null },
    rep: {
      min: null,
      max: null,
      user_identity: null,
      direction: null,
      category: null
    },
    level: { min: 0, max: null },
    tdh: {
      min: null,
      max: null,
      inclusion_strategy: ApiGroupTdhInclusionStrategy.Tdh
    },
    owns_nfts: [],
    identity_group_id: null,
    identity_group_identities_count: 0,
    excluded_identity_group_id: null,
    excluded_identity_group_identities_count: 0,
    is_beneficiary_of_grant_id: null,
    is_beneficiary_of_grant_match_mode:
      ApiGroupBeneficiaryGrantMatchMode.AnyToken,
    is_beneficiary_of_grant: null
  };
}

function serviceFor(group: ApiGroupDescription) {
  const service = new UserGroupsService(mock(), mock(), mock());
  const load = jest
    .spyOn(service, 'getByIdOrThrow')
    .mockImplementation(async () =>
      Object.assign(new ApiGroupFull(), {
        group: JSON.parse(JSON.stringify(group)) as ApiGroupDescription
      })
    );
  return { service, load };
}

describe('Online recipient group SQL', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue(null);
  });

  it('opts in only after loading the group through the existing access check', async () => {
    const { service, load } = serviceFor(levelZeroGroup());
    const ctx = {};
    const result = await service.getSqlAndParamsByGroupId('group', ctx, {
      forOnlineRecipients: true
    });
    expect(load).toHaveBeenCalledWith('group', ctx);
    expect(result?.sql).toContain('where exists');
    expect(result?.sql).not.toContain('included_profile_ids');
    expect(result?.params).toEqual({ level_min: 0 });
  });

  it('keeps the generic query for callers that did not opt in', async () => {
    const { service } = serviceFor(levelZeroGroup());
    const result = await service.getSqlAndParamsByGroupId('group', {});
    expect(result?.sql).toContain('included_profile_ids');
    expect(result?.sql).toContain('i.level_raw >= :level_min');
    expect(result?.params).toEqual({ level_min: 0 });
  });

  it('does not turn a missing or inaccessible group into a public audience', async () => {
    const { service, load } = serviceFor(levelZeroGroup());
    const denied = new NotFoundException('Group not found');
    load.mockRejectedValue(denied);
    await expect(
      service.getSqlAndParamsByGroupId(
        'private',
        {},
        { forOnlineRecipients: true }
      )
    ).rejects.toBe(denied);
  });

  const restrictions: [string, (group: ApiGroupDescription) => void][] = [
    [
      'reputation user',
      (g) => {
        g.rep.user_identity = 'missing-user';
      }
    ],
    [
      'CIC user',
      (g) => {
        g.cic.user_identity = 'missing-user';
      }
    ],
    [
      'reputation direction',
      (g) => {
        g.rep.direction = ApiGroupFilterDirection.Sent;
      }
    ],
    [
      'CIC direction',
      (g) => {
        g.cic.direction = ApiGroupFilterDirection.Sent;
      }
    ],
    [
      'upper level, including zero',
      (g) => {
        g.level.max = 0;
      }
    ],
    [
      'different minimum level',
      (g) => {
        g.level.min = 1;
      }
    ],
    [
      'no minimum level',
      (g) => {
        g.level.min = null;
      }
    ],
    [
      'minimum TDH, including zero',
      (g) => {
        g.tdh.min = 0;
      }
    ],
    [
      'maximum TDH',
      (g) => {
        g.tdh.max = 10;
      }
    ],
    [
      'different TDH strategy',
      (g) => {
        g.tdh.inclusion_strategy = ApiGroupTdhInclusionStrategy.Xtdh;
      }
    ],
    [
      'minimum reputation',
      (g) => {
        g.rep.min = 1;
      }
    ],
    [
      'maximum reputation',
      (g) => {
        g.rep.max = 0;
      }
    ],
    [
      'reputation category',
      (g) => {
        g.rep.category = 'art';
      }
    ],
    [
      'minimum CIC',
      (g) => {
        g.cic.min = 1;
      }
    ],
    [
      'maximum CIC',
      (g) => {
        g.cic.max = 0;
      }
    ],
    [
      'NFT ownership',
      (g) => {
        g.owns_nfts = [
          {
            name: ApiGroupOwnsNftNameEnum.Memes,
            tokens: [],
            match_mode: ApiGroupNftOwnershipMatchMode.AllTokens
          }
        ];
      }
    ],
    [
      'explicit inclusion',
      (g) => {
        g.identity_group_id = 'included';
      }
    ],
    [
      'explicit exclusion',
      (g) => {
        g.excluded_identity_group_id = 'excluded';
      }
    ],
    [
      'grant requirement',
      (g) => {
        g.is_beneficiary_of_grant_id = 'grant';
      }
    ],
    [
      'nondefault grant mode',
      (g) => {
        g.is_beneficiary_of_grant_match_mode =
          ApiGroupBeneficiaryGrantMatchMode.AllTokens;
      }
    ],
    [
      'unknown top-level rule',
      (g) => {
        Object.assign(g, { future_restriction: true });
      }
    ],
    [
      'unknown nested rule',
      (g) => {
        Object.assign(g.level, { future_restriction: true });
      }
    ]
  ];

  it.each(restrictions)(
    'keeps the existing SQL for %s',
    async (_name, restrict) => {
      const group = levelZeroGroup();
      restrict(group);
      const { service } = serviceFor(group);
      const original = await service.getSqlAndParamsByGroupId('group', {});
      const candidate = await service.getSqlAndParamsByGroupId(
        'group',
        {},
        { forOnlineRecipients: true }
      );
      expect(candidate).toEqual(original);
      expect(candidate?.sql ?? '').not.toContain(
        'eligible.level_raw >= :level_min'
      );
    }
  );

  it('does not optimize an ungrouped audience', async () => {
    const { service, load } = serviceFor(levelZeroGroup());
    const original = await service.getSqlAndParamsByGroupId(null, {});
    const candidate = await service.getSqlAndParamsByGroupId(
      null,
      {},
      { forOnlineRecipients: true }
    );
    expect(candidate).toEqual(original);
    expect(load).not.toHaveBeenCalled();
  });
});
