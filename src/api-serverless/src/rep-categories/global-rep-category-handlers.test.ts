import { ApiGlobalRepCategoryOverview } from '@/api/generated/models/ApiGlobalRepCategoryOverview';
import { ApiGlobalRepCategoryWaveOverview } from '@/api/generated/models/ApiGlobalRepCategoryWaveOverview';
import {
  GetGlobalRepCategoryGiversQuery,
  GetGlobalRepCategoryGiversRequest,
  GetGlobalRepCategoryOverviewRequest,
  GetGlobalRepCategoryRatingsQuery,
  GetGlobalRepCategoryRatingsRequest,
  GetGlobalRepCategoryRecipientsQuery,
  GetGlobalRepCategoryRecipientsRequest,
  GetGlobalRepCategoryWaveContributorsQuery,
  GetGlobalRepCategoryWaveContributorsRequest,
  GetGlobalRepCategoryWaveOverviewRequest,
  GetGlobalRepCategoryWavesQuery,
  GetGlobalRepCategoryWavesRequest
} from '@/api/generated/routes/operations';
import { PageSortDirection } from '@/api/page-request';
import { globalRepCategoryApiService } from '@/api/rep-categories/global-rep-category.api.service';
import {
  handleGetGlobalRepCategoryGivers,
  handleGetGlobalRepCategoryOverview,
  handleGetGlobalRepCategoryRatings,
  handleGetGlobalRepCategoryRecipients,
  handleGetGlobalRepCategoryWaveContributors,
  handleGetGlobalRepCategoryWaveOverview,
  handleGetGlobalRepCategoryWaves
} from '@/api/rep-categories/global-rep-category.handlers';

type QueryWithCategory<T> = T & {
  readonly category?: string;
};

function makeOverview(category: string): ApiGlobalRepCategoryOverview {
  return {
    category,
    total_rep: 0,
    pair_count: 0,
    giver_count: 0,
    recipient_count: 0,
    top_recipients: [],
    top_givers: [],
    recently_updated: []
  };
}

function makeWaveOverview(category: string): ApiGlobalRepCategoryWaveOverview {
  return {
    category,
    total_rep: 0,
    wave_count: 0,
    contributor_count: 0,
    top_waves: [],
    top_contributors: []
  };
}

function makeOverviewRequest(
  category: string
): GetGlobalRepCategoryOverviewRequest {
  return {
    params: { category },
    query: {},
    user: undefined
  } as unknown as GetGlobalRepCategoryOverviewRequest;
}

function makeRatingsRequest(
  category: string,
  query: QueryWithCategory<GetGlobalRepCategoryRatingsQuery> = {}
): GetGlobalRepCategoryRatingsRequest {
  return {
    params: { category },
    query,
    user: undefined
  } as unknown as GetGlobalRepCategoryRatingsRequest;
}

function makeRecipientsRequest(
  category: string,
  query: QueryWithCategory<GetGlobalRepCategoryRecipientsQuery> = {}
): GetGlobalRepCategoryRecipientsRequest {
  return {
    params: { category },
    query,
    user: undefined
  } as unknown as GetGlobalRepCategoryRecipientsRequest;
}

function makeGiversRequest(
  category: string,
  query: QueryWithCategory<GetGlobalRepCategoryGiversQuery> = {}
): GetGlobalRepCategoryGiversRequest {
  return {
    params: { category },
    query,
    user: undefined
  } as unknown as GetGlobalRepCategoryGiversRequest;
}

function makeWaveOverviewRequest(
  category: string
): GetGlobalRepCategoryWaveOverviewRequest {
  return {
    params: { category },
    query: {},
    user: undefined
  } as unknown as GetGlobalRepCategoryWaveOverviewRequest;
}

function makeWavesRequest(
  category: string,
  query: QueryWithCategory<GetGlobalRepCategoryWavesQuery> = {}
): GetGlobalRepCategoryWavesRequest {
  return {
    params: { category },
    query,
    user: undefined
  } as unknown as GetGlobalRepCategoryWavesRequest;
}

function makeWaveContributorsRequest(
  category: string,
  query: QueryWithCategory<GetGlobalRepCategoryWaveContributorsQuery> = {}
): GetGlobalRepCategoryWaveContributorsRequest {
  return {
    params: { category },
    query,
    user: undefined
  } as unknown as GetGlobalRepCategoryWaveContributorsRequest;
}

describe('global REP category handlers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts URL-decoded category names with spaces and punctuation', async () => {
    const overview = makeOverview("Dev extraordinaire (A), can't miss");
    const getOverview = jest
      .spyOn(globalRepCategoryApiService, 'getOverview')
      .mockResolvedValue(overview);

    await expect(
      handleGetGlobalRepCategoryOverview(
        makeOverviewRequest("Dev extraordinaire (A), can't miss")
      )
    ).resolves.toBe(overview);

    expect(getOverview).toHaveBeenCalledWith(
      { category: "Dev extraordinaire (A), can't miss" },
      expect.objectContaining({
        authenticationContext: expect.any(Object)
      })
    );
  });

  it('rejects invalid category names before calling the service', async () => {
    const getOverview = jest
      .spyOn(globalRepCategoryApiService, 'getOverview')
      .mockResolvedValue(makeOverview('bad-category'));

    await expect(
      handleGetGlobalRepCategoryOverview(makeOverviewRequest('bad-category'))
    ).rejects.toThrow('"category" with value "bad-category" fails');

    expect(getOverview).not.toHaveBeenCalled();
  });

  it('applies ratings query defaults and normalizes empty search', async () => {
    const getRatings = jest
      .spyOn(globalRepCategoryApiService, 'getRatings')
      .mockResolvedValue({ page: 1, next: false, data: [] });

    await handleGetGlobalRepCategoryRatings(
      makeRatingsRequest('Dev extraordinaire', {
        category: 'Different category',
        search: ''
      })
    );

    expect(getRatings).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 50,
        order: PageSortDirection.DESC,
        order_by: 'rep',
        search: null
      },
      expect.any(Object)
    );
  });

  it('validates recipient ranking query params', async () => {
    const getRecipients = jest
      .spyOn(globalRepCategoryApiService, 'getRecipients')
      .mockResolvedValue({ page: 2, next: false, data: [] });

    await handleGetGlobalRepCategoryRecipients(
      makeRecipientsRequest('Dev extraordinaire', {
        category: 'Different category',
        page: 2,
        page_size: 25,
        order: 'ASC',
        order_by: 'profile',
        search: 'alice'
      })
    );

    expect(getRecipients).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 2,
        page_size: 25,
        order: PageSortDirection.ASC,
        order_by: 'profile',
        search: 'alice'
      },
      expect.any(Object)
    );
  });

  it('validates giver ranking query params', async () => {
    const getGivers = jest
      .spyOn(globalRepCategoryApiService, 'getGivers')
      .mockResolvedValue({ page: 3, next: false, data: [] });

    await handleGetGlobalRepCategoryGivers(
      makeGiversRequest('Dev extraordinaire', {
        category: 'Different category',
        page: 3,
        page_size: 10,
        order: 'DESC',
        order_by: 'last_modified',
        search: 'bob'
      })
    );

    expect(getGivers).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 3,
        page_size: 10,
        order: PageSortDirection.DESC,
        order_by: 'last_modified',
        search: 'bob'
      },
      expect.any(Object)
    );
  });

  it('loads category-wide wave REP overview without requiring a wave search', async () => {
    const overview = makeWaveOverview('Dev extraordinaire');
    const getWaveOverview = jest
      .spyOn(globalRepCategoryApiService, 'getWaveOverview')
      .mockResolvedValue(overview);

    await expect(
      handleGetGlobalRepCategoryWaveOverview(
        makeWaveOverviewRequest('Dev extraordinaire')
      )
    ).resolves.toBe(overview);

    expect(getWaveOverview).toHaveBeenCalledWith(
      { category: 'Dev extraordinaire' },
      expect.any(Object)
    );
  });

  it('applies wave REP waves query defaults', async () => {
    const getWaves = jest
      .spyOn(globalRepCategoryApiService, 'getWaves')
      .mockResolvedValue({ page: 1, next: false, data: [] });

    await handleGetGlobalRepCategoryWaves(
      makeWavesRequest('Dev extraordinaire')
    );

    expect(getWaves).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 50,
        order: PageSortDirection.DESC,
        order_by: 'rep'
      },
      expect.any(Object)
    );
  });

  it('validates wave REP contributor query params', async () => {
    const getWaveContributors = jest
      .spyOn(globalRepCategoryApiService, 'getWaveContributors')
      .mockResolvedValue({ page: 2, next: false, data: [] });

    await handleGetGlobalRepCategoryWaveContributors(
      makeWaveContributorsRequest('Dev extraordinaire', {
        page: 2,
        page_size: 25,
        order: 'ASC',
        order_by: 'wave'
      })
    );

    expect(getWaveContributors).toHaveBeenCalledWith(
      {
        category: 'Dev extraordinaire',
        page: 2,
        page_size: 25,
        order: PageSortDirection.ASC,
        order_by: 'wave'
      },
      expect.any(Object)
    );
  });
});
