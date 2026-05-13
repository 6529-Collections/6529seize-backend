const mockFindWaves = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/api-wave-v2.service', () => ({
  apiWaveV2Service: {
    findWaves: mockFindWaves
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import { handleGetWavesV2 } from './get-waves-v2.handler';

describe('handleGetWavesV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], count: 0, page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindWaves.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies search view defaults before calling the service', async () => {
    const req = { query: {} } as any;

    await expect(handleGetWavesV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindWaves).toHaveBeenCalledWith(
      {
        view: ApiWavesV2ListType.Search,
        page: 1,
        page_size: 20
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('normalizes overview query params before calling the service', async () => {
    const req = {
      query: {
        view: 'overview',
        overview_type: 'most_subscribed',
        only_waves_followed_by_authenticated_user: 'true',
        direct_message: 'false',
        pinned: 'pinned'
      }
    } as any;

    await handleGetWavesV2(req);

    expect(mockFindWaves).toHaveBeenCalledWith(
      {
        view: ApiWavesV2ListType.Overview,
        page: 1,
        page_size: 10,
        overview_type: ApiWavesOverviewType.MostSubscribed,
        only_waves_followed_by_authenticated_user: true,
        direct_message: false,
        pinned: ApiWavesPinFilter.Pinned
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('rejects query params outside the active view schema', async () => {
    const req = { query: { unexpected: 'value' } } as any;

    await expect(handleGetWavesV2(req)).rejects.toThrow(
      '"unexpected" is not allowed'
    );
    expect(mockFindWaves).not.toHaveBeenCalled();
  });
});
