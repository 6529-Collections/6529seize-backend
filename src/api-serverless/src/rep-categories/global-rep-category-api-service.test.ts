import { PageSortDirection } from '@/api/page-request';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { GlobalRepCategoryApiService } from '@/api/rep-categories/global-rep-category.api.service';
import { GlobalRepCategoryDb } from '@/api/rep-categories/global-rep-category.db';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { RequestContext } from '@/request.context';

type GlobalRepCategoryDbMock = jest.Mocked<
  Pick<
    GlobalRepCategoryDb,
    | 'getOverviewStats'
    | 'getRecipientsPage'
    | 'getGiversPage'
    | 'getRatingsPage'
    | 'getSuggestedCategories'
    | 'getWaveOverviewStats'
    | 'getWavesPage'
    | 'getWaveContributorsPage'
    | 'getTopWaveContributorsByWaveIds'
  >
>;

type IdentityFetcherMock = jest.Mocked<
  Pick<IdentityFetcher, 'getOverviewsByIds'>
>;

type UserGroupsServiceMock = jest.Mocked<
  Pick<UserGroupsService, 'getGroupsUserIsEligibleFor'>
>;

type SuggestedCategoryRow = Awaited<
  ReturnType<GlobalRepCategoryDb['getSuggestedCategories']>
>[number];

function makeProfile(id: string): ApiProfileMin {
  return {
    id,
    handle: id,
    primary_address: `${id}-wallet`,
    pfp: null,
    banner1_color: null,
    banner2_color: null,
    cic: 0,
    rep: 0,
    tdh: 0,
    xtdh: 0,
    xtdh_rate: 0,
    tdh_rate: 0,
    level: 0,
    classification: ApiProfileClassification.Pseudonym,
    sub_classification: null,
    archived: false,
    profile_wave_id: null,
    subscribed_actions: [],
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    is_wave_creator: false
  };
}

function makeSuggestedCategoryRow({
  category,
  totalRep = '1',
  profileRep = '1',
  waveRep = '0',
  ratingCount = '1',
  lastModified = '2026-06-07T00:00:00.000Z'
}: {
  readonly category: string;
  readonly totalRep?: string;
  readonly profileRep?: string;
  readonly waveRep?: string;
  readonly ratingCount?: string;
  readonly lastModified?: string;
}): SuggestedCategoryRow {
  return {
    category,
    total_rep: totalRep,
    profile_rep: profileRep,
    wave_rep: waveRep,
    rating_count: ratingCount,
    last_modified: lastModified
  };
}

function makeInvalidSuggestedCategoryRows(): SuggestedCategoryRow[] {
  return Array.from({ length: 36 }, (_, index) =>
    makeSuggestedCategoryRow({ category: `Invalid <category ${index}>` })
  );
}

function createService() {
  const globalRepCategoryDb: GlobalRepCategoryDbMock = {
    getOverviewStats: jest.fn().mockResolvedValue({
      total_rep: '-5',
      pair_count: '3',
      giver_count: '2',
      recipient_count: '2'
    }),
    getRecipientsPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: [
        {
          profile_id: 'recipient-1',
          total_rep: '15',
          rater_count: '2',
          last_modified: new Date('2026-06-02T10:00:00.000Z')
        }
      ]
    }),
    getGiversPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: [
        {
          profile_id: 'giver-1',
          total_rep: '-5',
          recipient_count: '2',
          last_modified: '2026-06-02T09:00:00.000Z'
        }
      ]
    }),
    getRatingsPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: [
        {
          giver_profile_id: 'giver-1',
          recipient_profile_id: 'recipient-1',
          rep: '-7',
          last_modified: new Date('2026-06-03T00:00:00.000Z'),
          category: "Dev extraordinaire (A), can't miss"
        }
      ]
    }),
    getSuggestedCategories: jest.fn().mockResolvedValue([]),
    getWaveOverviewStats: jest.fn().mockResolvedValue({
      total_rep: '0',
      wave_count: '0',
      contributor_count: '0'
    }),
    getWavesPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: []
    }),
    getWaveContributorsPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: []
    }),
    getTopWaveContributorsByWaveIds: jest.fn().mockResolvedValue([])
  };
  const profiles = ['giver-1', 'giver-2', 'recipient-1', 'recipient-2'].reduce(
    (acc, id) => {
      acc[id] = makeProfile(id);
      return acc;
    },
    {} as Record<string, ApiProfileMin>
  );
  const identityFetcher: IdentityFetcherMock = {
    getOverviewsByIds: jest.fn().mockResolvedValue(profiles)
  };
  const userGroupsService: UserGroupsServiceMock = {
    getGroupsUserIsEligibleFor: jest
      .fn()
      .mockImplementation((profileId: string | null) =>
        Promise.resolve(profileId ? ['group-1'] : [])
      )
  };

  return {
    service: new GlobalRepCategoryApiService(
      globalRepCategoryDb as unknown as GlobalRepCategoryDb,
      identityFetcher as unknown as IdentityFetcher,
      userGroupsService as unknown as UserGroupsService
    ),
    globalRepCategoryDb,
    identityFetcher,
    userGroupsService,
    profiles
  };
}

describe('GlobalRepCategoryApiService', () => {
  it('maps suggested categories with profile and wave REP totals', async () => {
    const { service, globalRepCategoryDb, userGroupsService } = createService();
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('profile-1')
    } as unknown as RequestContext;
    globalRepCategoryDb.getSuggestedCategories.mockResolvedValueOnce([
      makeSuggestedCategoryRow({
        category: 'Invalid <category>',
        totalRep: '1000',
        profileRep: '1000'
      }),
      makeSuggestedCategoryRow({
        category: 'Builder',
        totalRep: '125',
        profileRep: '25',
        waveRep: '100',
        ratingCount: '4',
        lastModified: '2026-06-06T00:00:00.000Z'
      })
    ]);

    await expect(service.getSuggestedCategories(ctx)).resolves.toEqual([
      {
        category: 'Builder',
        total_rep: 125,
        profile_rep: 25,
        wave_rep: 100,
        rating_count: 4,
        last_modified: '2026-06-06T00:00:00.000Z'
      }
    ]);

    expect(globalRepCategoryDb.getSuggestedCategories).toHaveBeenCalledWith(
      { limit: 36, offset: 0, groupIdsUserIsEligibleFor: ['group-1'] },
      ctx
    );
    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'profile-1',
      undefined
    );
  });

  it('continues fetching suggested categories until enough valid names are collected', async () => {
    const { service, globalRepCategoryDb } = createService();
    globalRepCategoryDb.getSuggestedCategories
      .mockResolvedValueOnce(makeInvalidSuggestedCategoryRows())
      .mockResolvedValueOnce([
        makeSuggestedCategoryRow({
          category: 'Builder',
          totalRep: '99',
          ratingCount: '3'
        })
      ]);

    await expect(service.getSuggestedCategories({})).resolves.toEqual([
      {
        category: 'Builder',
        total_rep: 99,
        profile_rep: 1,
        wave_rep: 0,
        rating_count: 3,
        last_modified: '2026-06-07T00:00:00.000Z'
      }
    ]);

    expect(globalRepCategoryDb.getSuggestedCategories).toHaveBeenNthCalledWith(
      1,
      { limit: 36, offset: 0, groupIdsUserIsEligibleFor: [] },
      {}
    );
    expect(globalRepCategoryDb.getSuggestedCategories).toHaveBeenNthCalledWith(
      2,
      { limit: 36, offset: 36, groupIdsUserIsEligibleFor: [] },
      {}
    );
  });

  it('stops suggested category paging after the max query page cap', async () => {
    const { service, globalRepCategoryDb } = createService();
    globalRepCategoryDb.getSuggestedCategories.mockResolvedValue(
      makeInvalidSuggestedCategoryRows()
    );

    await expect(service.getSuggestedCategories({})).resolves.toEqual([]);

    expect(globalRepCategoryDb.getSuggestedCategories).toHaveBeenCalledTimes(
      10
    );
    expect(globalRepCategoryDb.getSuggestedCategories).toHaveBeenLastCalledWith(
      { limit: 36, offset: 324, groupIdsUserIsEligibleFor: [] },
      {}
    );
  });

  it('builds overview with signed totals, rankings and recent pair activity', async () => {
    const { service, globalRepCategoryDb, profiles } = createService();

    await expect(
      service.getOverview(
        { category: "Dev extraordinaire (A), can't miss" },
        {}
      )
    ).resolves.toEqual({
      category: "Dev extraordinaire (A), can't miss",
      total_rep: -5,
      pair_count: 3,
      giver_count: 2,
      recipient_count: 2,
      top_recipients: [
        {
          profile: profiles['recipient-1'],
          total_rep: 15,
          rater_count: 2,
          last_modified: '2026-06-02T10:00:00.000Z'
        }
      ],
      top_givers: [
        {
          profile: profiles['giver-1'],
          total_rep: -5,
          recipient_count: 2,
          last_modified: '2026-06-02T09:00:00.000Z'
        }
      ],
      recently_updated: [
        {
          category: "Dev extraordinaire (A), can't miss",
          giver: profiles['giver-1'],
          recipient: profiles['recipient-1'],
          rep: -7,
          last_modified: '2026-06-03T00:00:00.000Z'
        }
      ]
    });

    expect(globalRepCategoryDb.getRecipientsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "Dev extraordinaire (A), can't miss",
        page: 1,
        page_size: 10,
        order: PageSortDirection.DESC,
        order_by: 'rep'
      }),
      {}
    );
  });

  it('maps ratings pages with hydrated giver and recipient profiles', async () => {
    const { service, globalRepCategoryDb, profiles } = createService();
    globalRepCategoryDb.getRatingsPage.mockResolvedValueOnce({
      page: 2,
      next: true,
      data: [
        {
          giver_profile_id: 'giver-2',
          recipient_profile_id: 'recipient-2',
          rep: '30',
          last_modified: '2026-06-04T00:00:00.000Z',
          category: 'Dev extraordinaire'
        }
      ]
    });

    await expect(
      service.getRatings(
        {
          category: 'Dev extraordinaire',
          page: 2,
          page_size: 1,
          order: PageSortDirection.ASC,
          order_by: 'giver',
          search: 'bob'
        },
        {}
      )
    ).resolves.toEqual({
      page: 2,
      next: true,
      data: [
        {
          category: 'Dev extraordinaire',
          giver: profiles['giver-2'],
          recipient: profiles['recipient-2'],
          rep: 30,
          last_modified: '2026-06-04T00:00:00.000Z'
        }
      ]
    });

    expect(globalRepCategoryDb.getRatingsPage).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 2,
        page_size: 1,
        order: PageSortDirection.ASC,
        order_by: 'giver',
        search: 'bob'
      },
      {}
    );
  });

  it('builds wave overview from category-wide wave REP analytics', async () => {
    const { service, globalRepCategoryDb, userGroupsService, profiles } =
      createService();
    const ctx = {
      authenticationContext:
        AuthenticationContext.fromProfileId('viewer-profile')
    } as unknown as RequestContext;
    globalRepCategoryDb.getWaveOverviewStats.mockResolvedValueOnce({
      total_rep: '-12',
      wave_count: '2',
      contributor_count: '2'
    });
    globalRepCategoryDb.getWavesPage.mockResolvedValueOnce({
      page: 1,
      next: false,
      data: [
        {
          wave_id: 'wave-1',
          wave_name: 'Wave one',
          wave_picture: null,
          is_direct_message: false,
          total_rep: '-10',
          contributor_count: '2',
          last_modified: '2026-06-05T00:00:00.000Z'
        }
      ]
    });
    globalRepCategoryDb.getWaveContributorsPage.mockResolvedValueOnce({
      page: 1,
      next: false,
      data: [
        {
          wave_id: 'wave-1',
          wave_name: 'Wave one',
          wave_picture: null,
          is_direct_message: false,
          profile_id: 'giver-1',
          contribution: '-10',
          last_modified: '2026-06-05T00:00:00.000Z'
        }
      ]
    });
    globalRepCategoryDb.getTopWaveContributorsByWaveIds.mockResolvedValueOnce([
      {
        wave_id: 'wave-1',
        wave_name: 'Wave one',
        wave_picture: null,
        is_direct_message: false,
        profile_id: 'giver-2',
        contribution: '7',
        last_modified: '2026-06-04T00:00:00.000Z'
      }
    ]);

    await expect(
      service.getWaveOverview({ category: 'Dev extraordinaire' }, ctx)
    ).resolves.toEqual({
      category: 'Dev extraordinaire',
      total_rep: -12,
      wave_count: 2,
      contributor_count: 2,
      top_waves: [
        {
          wave: {
            id: 'wave-1',
            name: 'Wave one',
            pfp: null,
            is_direct_message: false
          },
          total_rep: -10,
          contributor_count: 2,
          last_modified: '2026-06-05T00:00:00.000Z',
          top_contributors: [
            {
              wave: {
                id: 'wave-1',
                name: 'Wave one',
                pfp: null,
                is_direct_message: false
              },
              profile: profiles['giver-2'],
              contribution: 7,
              last_modified: '2026-06-04T00:00:00.000Z'
            }
          ]
        }
      ],
      top_contributors: [
        {
          wave: {
            id: 'wave-1',
            name: 'Wave one',
            pfp: null,
            is_direct_message: false
          },
          profile: profiles['giver-1'],
          contribution: -10,
          last_modified: '2026-06-05T00:00:00.000Z'
        }
      ]
    });

    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'viewer-profile',
      undefined
    );
    expect(globalRepCategoryDb.getWavesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'Dev extraordinaire',
        groupIdsUserIsEligibleFor: ['group-1'],
        order_by: 'rep'
      }),
      ctx
    );
    expect(
      globalRepCategoryDb.getTopWaveContributorsByWaveIds
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'Dev extraordinaire',
        waveIds: ['wave-1'],
        groupIdsUserIsEligibleFor: ['group-1']
      }),
      ctx
    );
  });

  it('does not expose private wave REP through proxies without READ_WAVE', async () => {
    const { service, globalRepCategoryDb, userGroupsService } = createService();
    const ctx = {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'proxy-profile',
        roleProfileId: 'owner-profile',
        activeProxyActions: []
      })
    } as unknown as RequestContext;

    await service.getWaveOverview({ category: 'Dev extraordinaire' }, ctx);

    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(globalRepCategoryDb.getWaveOverviewStats).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'Dev extraordinaire',
        groupIdsUserIsEligibleFor: []
      }),
      ctx
    );
    expect(globalRepCategoryDb.getWavesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupIdsUserIsEligibleFor: []
      }),
      ctx
    );
    expect(globalRepCategoryDb.getWaveContributorsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupIdsUserIsEligibleFor: []
      }),
      ctx
    );
  });

  it('allows proxies with READ_WAVE to use the role profile wave visibility', async () => {
    const { service, globalRepCategoryDb, userGroupsService } = createService();
    const ctx = {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'proxy-profile',
        roleProfileId: 'owner-profile',
        activeProxyActions: [
          {
            id: 'proxy-action-1',
            type: ProfileProxyActionType.READ_WAVE,
            credit_amount: null,
            credit_spent: null
          }
        ]
      })
    } as unknown as RequestContext;

    await service.getWaves(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 10,
        order: PageSortDirection.DESC,
        order_by: 'rep'
      },
      ctx
    );

    expect(userGroupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'owner-profile',
      undefined
    );
    expect(globalRepCategoryDb.getWavesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        groupIdsUserIsEligibleFor: ['group-1']
      }),
      ctx
    );
  });

  it('does not mask invalid or unsafe DB integers as zero', async () => {
    const { service, globalRepCategoryDb } = createService();
    globalRepCategoryDb.getOverviewStats.mockResolvedValueOnce({
      total_rep: 'not-a-number',
      pair_count: '1',
      giver_count: '1',
      recipient_count: '1'
    });

    await expect(
      service.getOverview({ category: 'Dev extraordinaire' }, {})
    ).rejects.toThrow(
      'Invalid integer value for global REP category field total_rep'
    );

    globalRepCategoryDb.getOverviewStats.mockResolvedValueOnce({
      total_rep: `${Number.MAX_SAFE_INTEGER + 1}`,
      pair_count: '1',
      giver_count: '1',
      recipient_count: '1'
    });

    await expect(
      service.getOverview({ category: 'Dev extraordinaire' }, {})
    ).rejects.toThrow(
      'Invalid integer value for global REP category field total_rep'
    );
  });
});
