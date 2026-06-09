const mockFindWavePolls = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/drop-polls.api.service', () => ({
  dropPollsApiService: {
    findWavePolls: mockFindWavePolls
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { PageSortDirection } from '@/api/page-request';
import { DropPollsOrderBy, DropPollState } from './drop-polls.db';
import { handleGetWavePollsV2 } from './drop-polls.handlers';

describe('drop polls handlers', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { count: 0, page: 1, next: false, data: [] };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindWavePolls.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  describe('handleGetWavePollsV2', () => {
    it('uses created_at descending sort without state filtering by default', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: {}
      } as any;

      await expect(handleGetWavePollsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindWavePolls).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page: 1,
          page_size: 20,
          sort_direction: PageSortDirection.DESC,
          sort: DropPollsOrderBy.CREATED_AT,
          state: null
        },
        { authenticationContext, timer }
      );
    });

    it('passes explicit closing time sort and open state filters', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: {
          page: '2',
          page_size: '10',
          sort_direction: 'ASC',
          sort: 'closing_time',
          state: 'OPEN'
        }
      } as any;

      await handleGetWavePollsV2(req);

      expect(mockFindWavePolls).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page: 2,
          page_size: 10,
          sort_direction: PageSortDirection.ASC,
          sort: DropPollsOrderBy.CLOSING_TIME,
          state: DropPollState.OPEN
        },
        { authenticationContext, timer }
      );
    });
  });
});
