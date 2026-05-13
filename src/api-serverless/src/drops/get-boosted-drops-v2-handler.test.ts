const mockFindBoostedDrops = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findBoostedDrops: mockFindBoostedDrops
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { handleGetBoostedDropsV2 } from './get-boosted-drops-v2.handler';

describe('handleGetBoostedDropsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], count: 0, page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindBoostedDrops.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { query: {} } as any;

    await expect(handleGetBoostedDropsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindBoostedDrops).toHaveBeenCalledWith(
      {
        author: null,
        booster: null,
        wave_id: null,
        min_boosts: null,
        count_only_boosts_after: 1,
        page_size: DEFAULT_PAGE_SIZE,
        page: 1,
        sort_direction: ApiPageSortDirection.Desc,
        sort: 'last_boosted_at'
      },
      {
        timer,
        authenticationContext
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = {
      query: {
        author: 'author-identity',
        booster: 'booster-identity',
        wave_id: 'wave-1',
        min_boosts: '3',
        count_only_boosts_after: '123',
        page_size: '25',
        page: '2',
        sort_direction: ApiPageSortDirection.Asc,
        sort: 'boosts'
      }
    } as any;

    await handleGetBoostedDropsV2(req);

    expect(mockFindBoostedDrops).toHaveBeenCalledWith(
      {
        author: 'author-identity',
        booster: 'booster-identity',
        wave_id: 'wave-1',
        min_boosts: 3,
        count_only_boosts_after: 123,
        page_size: 25,
        page: 2,
        sort_direction: ApiPageSortDirection.Asc,
        sort: 'boosts'
      },
      {
        timer,
        authenticationContext
      }
    );
  });

  it('rejects invalid query params', async () => {
    const req = { query: { page_size: '2001' } } as any;

    await expect(handleGetBoostedDropsV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 2000'
    );
    expect(mockFindBoostedDrops).not.toHaveBeenCalled();
  });
});
