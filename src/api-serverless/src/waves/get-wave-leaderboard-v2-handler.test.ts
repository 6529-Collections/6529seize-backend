const mockFindLeaderboardV2 = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: {
    findLeaderboardV2: mockFindLeaderboardV2
  }
}));

jest.mock('@/drops/drops.db', () => ({
  LeaderboardSort: {
    RANK: 'RANK',
    REALTIME_VOTE: 'REALTIME_VOTE',
    MY_REALTIME_VOTE: 'MY_REALTIME_VOTE',
    CREATED_AT: 'CREATED_AT',
    PRICE: 'PRICE',
    RATING_PREDICTION: 'RATING_PREDICTION',
    TREND: 'TREND'
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { PageSortDirection } from '@/api/page-request';
import { LeaderboardSort } from '@/drops/drops.db';
import { handleGetWaveLeaderboardV2 } from './get-wave-leaderboard-v2.handler';

describe('handleGetWaveLeaderboardV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], count: 0, page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindLeaderboardV2.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { params: { id: 'wave-1' }, query: {} } as any;

    await expect(handleGetWaveLeaderboardV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindLeaderboardV2).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        page_size: 50,
        page: 1,
        curation_id: null,
        unvoted_by_me: false,
        price_currency: null,
        min_price: null,
        max_price: null,
        sort_direction: PageSortDirection.ASC,
        sort: LeaderboardSort.RANK
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = {
      params: { id: 'wave-1' },
      query: {
        page_size: '25',
        page: '2',
        curation_id: 'curation-1',
        unvoted_by_me: 'true',
        price_currency: 'eth',
        min_price: '1.5',
        max_price: '3',
        sort_direction: PageSortDirection.DESC,
        sort: LeaderboardSort.PRICE
      }
    } as any;

    await handleGetWaveLeaderboardV2(req);

    expect(mockFindLeaderboardV2).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        page_size: 25,
        page: 2,
        curation_id: 'curation-1',
        unvoted_by_me: true,
        price_currency: 'eth',
        min_price: 1.5,
        max_price: 3,
        sort_direction: PageSortDirection.DESC,
        sort: LeaderboardSort.PRICE
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('rejects invalid query params', async () => {
    const req = {
      params: { id: 'wave-1' },
      query: { page_size: '101' }
    } as any;

    await expect(handleGetWaveLeaderboardV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 100'
    );
    expect(mockFindLeaderboardV2).not.toHaveBeenCalled();
  });
});
