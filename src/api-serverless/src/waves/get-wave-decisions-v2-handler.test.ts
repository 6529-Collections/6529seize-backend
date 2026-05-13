const mockSearchConcludedWaveDecisionsV2 = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/wave-decisions-api.service', () => ({
  waveDecisionsApiService: {
    searchConcludedWaveDecisionsV2: mockSearchConcludedWaveDecisionsV2
  },
  WaveDecisionsQuerySort: {
    decision_time: 'decision_time'
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { PageSortDirection } from '@/api/page-request';
import { handleGetWaveDecisionsV2 } from './get-wave-decisions-v2.handler';

describe('handleGetWaveDecisionsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], count: 0, page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchConcludedWaveDecisionsV2.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { params: { id: 'wave-1' }, query: {} } as any;

    await expect(handleGetWaveDecisionsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockSearchConcludedWaveDecisionsV2).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        page_size: 100,
        page: 1,
        sort_direction: PageSortDirection.DESC,
        sort: 'decision_time'
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
        page_size: '50',
        page: '2',
        sort_direction: PageSortDirection.ASC,
        sort: 'decision_time'
      }
    } as any;

    await handleGetWaveDecisionsV2(req);

    expect(mockSearchConcludedWaveDecisionsV2).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        page_size: 50,
        page: 2,
        sort_direction: PageSortDirection.ASC,
        sort: 'decision_time'
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
      query: { page_size: '2001' }
    } as any;

    await expect(handleGetWaveDecisionsV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 2000'
    );
    expect(mockSearchConcludedWaveDecisionsV2).not.toHaveBeenCalled();
  });
});
