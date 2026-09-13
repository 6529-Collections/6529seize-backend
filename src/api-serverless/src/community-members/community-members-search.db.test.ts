import { mock } from 'ts-jest-mocker';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import { ADDRESS_CONSOLIDATION_KEY, PROFILE_GROUPS_TABLE } from '@/constants';
import { ApiGroupDescription } from '@/api/generated/models/ApiGroupDescription';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { ApiGroupFilterDirection } from '@/api/generated/models/ApiGroupFilterDirection';
import { ApiGroupTdhInclusionStrategy } from '@/api/generated/models/ApiGroupTdhInclusionStrategy';
import { ApiGroupBeneficiaryGrantMatchMode } from '@/api/generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiCommunityMembersSortOption } from '@/api/generated/models/ApiCommunityMembersSortOption';
import { ApiCreateGroupDescription } from '@/api/generated/models/ApiCreateGroupDescription';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { PageSortDirection } from '@/api/page-request';
import { CommunityMembersDb } from './community-members.db';
import { UserGroupsService } from './user-groups.service';
import { CommunityMembersQuery } from './community-members.types';

const identities = [
  ['alice', 'Alice', '0xalice', 'alice-main'],
  ['alice', 'Secondary', '0xsecondary', 'alice-second'],
  ['bob', 'AliceBob', '0xbob', 'bob-main'],
  ['negative', 'AliceNegative', '0xnegative', 'negative-main'],
  ['unrated', 'AliceUnrated', '0xunrated', 'unrated-main'],
  ['CASEID', 'CaseMember', '0xcase', 'case-main'],
  ['noise', 'Unrelated', '0xnoise', 'noise-main']
].map(([profile_id, handle, primary_address, consolidation_key]) =>
  anIdentity(
    // Deliberately stale cached REP: eligibility must keep using live ratings.
    { rep: -999 },
    { profile_id, handle, primary_address, consolidation_key }
  )
);

const ratingRows: [string, string, string, number][] = [
  ['giver', 'alice', 'Art', 10],
  ['other', 'alice', 'Art', -3],
  ['giver', 'alice', 'Code', -2],
  ['giver', 'bob', 'Art', 2],
  ['other', 'bob', 'Code', 3],
  ['giver', 'negative', 'Art', -5],
  ['giver', 'unrated', 'Art', 0],
  ['giver', 'noise', 'Art', 100],
  ['alice', 'recipient', 'Art', 7],
  ['alice', 'recipient', 'Code', -2],
  ['bob', 'recipient', 'Art', -5],
  ['noise', 'recipient', 'Art', 100],
  ['giver', 'caseid', 'Art', 7]
];

function groupRules(): ApiGroupDescription {
  return {
    rep: {
      min: 1,
      max: null,
      user_identity: null,
      direction: null,
      category: null
    },
    cic: { min: null, max: null, user_identity: null, direction: null },
    level: { min: null, max: null },
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

function query(param: string | null): CommunityMembersQuery {
  return {
    group_id: 'test-group',
    param,
    page: 1,
    page_size: 20,
    sort: ApiCommunityMembersSortOption.Display,
    sort_direction: PageSortDirection.ASC
  };
}

function makeRepositories(group: ApiGroupDescription) {
  const service = new UserGroupsService(mock(), mock(), mock());
  jest
    .spyOn(service, 'getByIdOrThrow')
    .mockImplementation(async () =>
      Object.assign(new ApiGroupFull(), { group: structuredClone(group) })
    );
  const optimized = new CommunityMembersDb(() => sqlExecutor, service);
  // Omitting the new option runs the unchanged general SQL used before the fix.
  const original = new CommunityMembersDb(() => sqlExecutor, {
    getSqlAndParamsByGroupId: (id, ctx) =>
      service.getSqlAndParamsByGroupId(id, ctx),
    getSqlAndParamsForPreview: (description, ctx) =>
      service.getSqlAndParamsForPreview(description, ctx)
  } as UserGroupsService);
  return { service, optimized, original };
}

describeWithSeed(
  'Community member REP search SQL',
  [
    withIdentities(identities),
    withRatings(
      ratingRows.map(
        ([rater_profile_id, matter_target_id, matter_category, rating]) =>
          aRepRating({
            rater_profile_id,
            matter_target_id,
            matter_category,
            rating
          })
      )
    ),
    {
      table: PROFILE_GROUPS_TABLE,
      rows: [
        { profile_group_id: 'included', profile_id: 'unrated' },
        { profile_group_id: 'excluded', profile_id: 'bob' }
      ]
    },
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: identities.map((identity) => ({
        address: identity.primary_address,
        consolidation_key: identity.consolidation_key
      }))
    }
  ],
  () => {
    beforeEach(() => {
      jest
        .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
        .mockImplementation(
          async ({ identityKey }) => ({ id: identityKey }) as never
        );
    });
    afterEach(() => jest.restoreAllMocks());

    const cases: [
      string,
      Partial<ApiGroupDescription['rep']>,
      string | null
    ][] = [
      ['received total', {}, ' ALICE '],
      ['received category', { category: 'Art' }, 'alice'],
      ['received user', { user_identity: 'giver' }, 'alice'],
      [
        'received user/category',
        { user_identity: 'giver', category: 'Art' },
        'alice'
      ],
      ['sent total', { direction: ApiGroupFilterDirection.Sent }, 'alice'],
      [
        'sent category',
        { direction: ApiGroupFilterDirection.Sent, category: 'Art' },
        'alice'
      ],
      [
        'sent user',
        { direction: ApiGroupFilterDirection.Sent, user_identity: 'recipient' },
        'alice'
      ],
      [
        'sent user/category',
        {
          direction: ApiGroupFilterDirection.Sent,
          user_identity: 'recipient',
          category: 'Code',
          min: -10,
          max: -1
        },
        'alice'
      ],
      ['negative totals', { min: -10, max: -1 }, 'alice'],
      ['multiple identity rows', { min: 5, max: 5 }, '0xsecondary'],
      ['missing match', {}, "' OR 1=1 --"],
      ['legacy mixed-collation profile match', {}, 'CaseMember'],
      ['empty search', {}, '  '],
      ['no search', {}, null]
    ];

    it.each(cases)(
      'preserves list and count for %s',
      async (_name, rep, param) => {
        const group = groupRules();
        Object.assign(group.rep, rep);
        const { original, optimized } = makeRepositories(group);
        const search = query(param);
        expect(await optimized.getCommunityMembers(search, {})).toEqual(
          await original.getCommunityMembers(search, {})
        );
        expect(await optimized.countCommunityMembers(search, {})).toEqual(
          await original.countCommunityMembers(search, {})
        );
      }
    );

    it('sums only candidate profiles without multiplying their ratings', async () => {
      const { service, optimized } = makeRepositories(groupRules());
      const membership = await service.getSqlAndParamsByGroupId(
        'test-group',
        {},
        { memberSearch: 'alice' }
      );
      expect(membership).not.toBeNull();
      const grouped = await sqlExecutor.execute<{
        profile_id: string;
        rating: number;
      }>(
        `${membership!.sql} select profile_id, rating from grouped_reps order by profile_id`,
        membership!.params
      );
      expect(grouped).toEqual([
        { profile_id: 'alice', rating: 5 },
        { profile_id: 'bob', rating: 5 },
        { profile_id: 'negative', rating: -5 }
      ]);
      const rows = await optimized.getCommunityMembers(query('alice'), {});
      expect(rows.map((row) => row.display)).toEqual(['Alice', 'AliceBob']);
      expect(await optimized.countCommunityMembers(query('alice'), {})).toBe(2);
      expect(rows.every((row) => row.rep === -999)).toBe(true);
    });

    it('keeps the legacy case-insensitive match across profile column collations', async () => {
      const { optimized } = makeRepositories(groupRules());
      const rows = await optimized.getCommunityMembers(query('CaseMember'), {});
      expect(rows.map((row) => row.display)).toEqual(['CaseMember']);
      expect(
        await optimized.countCommunityMembers(query('CaseMember'), {})
      ).toBe(1);
    });

    it('preserves explicit inclusion, exclusion and pagination', async () => {
      const group = groupRules();
      group.identity_group_id = 'included';
      group.excluded_identity_group_id = 'excluded';
      const { original, optimized } = makeRepositories(group);
      const search = { ...query('alice'), page_size: 1, page: 2 };
      const rows = await optimized.getCommunityMembers(search, {});
      expect(rows.map((row) => row.display)).toEqual(['AliceUnrated']);
      expect(rows).toEqual(await original.getCommunityMembers(search, {}));
      expect(await optimized.countCommunityMembers(search, {})).toBe(2);
      expect(await original.countCommunityMembers(search, {})).toBe(2);
    });

    it('preserves preview address inclusion and exclusion', async () => {
      const group = groupRules();
      const preview: ApiCreateGroupDescription = {
        ...group,
        identity_addresses: ['0xunrated'],
        excluded_identity_addresses: ['0xbob']
      };
      const { original, optimized } = makeRepositories(group);
      const search = query('alice');
      const rows = await optimized.getCommunityMembers(search, {}, preview);
      expect(rows.map((row) => row.display)).toEqual(['Alice', 'AliceUnrated']);
      expect(rows).toEqual(
        await original.getCommunityMembers(search, {}, preview)
      );
      expect(await optimized.countCommunityMembers(search, {}, preview)).toBe(
        2
      );
      expect(await original.countCommunityMembers(search, {}, preview)).toBe(2);
    });

    it('keeps SQL unchanged without a search or REP criteria', async () => {
      const group = groupRules();
      const { service } = makeRepositories(group);
      const original = await service.getSqlAndParamsByGroupId('test-group', {});
      expect(
        await service.getSqlAndParamsByGroupId(
          'test-group',
          {},
          { memberSearch: ' ' }
        )
      ).toEqual(original);
      group.rep.min = null;
      expect(
        await service.getSqlAndParamsByGroupId(
          'test-group',
          {},
          { memberSearch: 'alice' }
        )
      ).toEqual(await service.getSqlAndParamsByGroupId('test-group', {}));
    });
  }
);
