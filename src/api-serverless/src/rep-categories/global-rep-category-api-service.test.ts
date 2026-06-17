import { PageSortDirection } from '@/api/page-request';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { GlobalRepCategoryApiService } from '@/api/rep-categories/global-rep-category.api.service';
import { GlobalRepCategoryDb } from '@/api/rep-categories/global-rep-category.db';

type GlobalRepCategoryDbMock = jest.Mocked<
  Pick<
    GlobalRepCategoryDb,
    | 'getOverviewStats'
    | 'getRecipientsPage'
    | 'getGiversPage'
    | 'getRatingsPage'
  >
>;

type IdentityFetcherMock = jest.Mocked<
  Pick<IdentityFetcher, 'getOverviewsByIds'>
>;

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
    })
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

  return {
    service: new GlobalRepCategoryApiService(
      globalRepCategoryDb as unknown as GlobalRepCategoryDb,
      identityFetcher as unknown as IdentityFetcher
    ),
    globalRepCategoryDb,
    identityFetcher,
    profiles
  };
}

describe('GlobalRepCategoryApiService', () => {
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
