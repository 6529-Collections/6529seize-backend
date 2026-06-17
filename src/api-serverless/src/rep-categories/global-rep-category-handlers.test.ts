import { ApiGlobalRepCategoryOverview } from '@/api/generated/models/ApiGlobalRepCategoryOverview';
import { globalRepCategoryApiService } from './global-rep-category.api.service';
import { handleGetGlobalRepCategoryOverview } from './global-rep-category.handlers';

describe('global REP category handlers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts URL-decoded category names with spaces and punctuation', async () => {
    const overview: ApiGlobalRepCategoryOverview = {
      category: "Dev extraordinaire (A), can't miss",
      total_rep: 0,
      pair_count: 0,
      giver_count: 0,
      recipient_count: 0,
      top_recipients: [],
      top_givers: [],
      recently_updated: []
    };
    const getOverview = jest
      .spyOn(globalRepCategoryApiService, 'getOverview')
      .mockResolvedValue(overview);

    await expect(
      handleGetGlobalRepCategoryOverview({
        params: { category: "Dev extraordinaire (A), can't miss" },
        query: {},
        user: undefined
      } as any)
    ).resolves.toBe(overview);

    expect(getOverview).toHaveBeenCalledWith(
      { category: "Dev extraordinaire (A), can't miss" },
      expect.objectContaining({
        authenticationContext: expect.any(Object)
      })
    );
  });
});
