const mockFindWaveCurationDrops = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/api-wave-v2.service', () => ({
  apiWaveV2Service: {
    findWaveCurationDrops: mockFindWaveCurationDrops
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleListWaveCurationDropsV2 } from './list-wave-curation-drops-v2.handler';

describe('handleListWaveCurationDropsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindWaveCurationDrops.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = {
      params: { id: 'wave-1', curation_id: 'curation-1' },
      query: {}
    } as any;

    await expect(handleListWaveCurationDropsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindWaveCurationDrops).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        curation_id: 'curation-1',
        page: 1,
        page_size: 50
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = {
      params: { id: 'wave-1', curation_id: 'curation-1' },
      query: { page: '2', page_size: '25' }
    } as any;

    await handleListWaveCurationDropsV2(req);

    expect(mockFindWaveCurationDrops).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        curation_id: 'curation-1',
        page: 2,
        page_size: 25
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('rejects invalid query params', async () => {
    const req = {
      params: { id: 'wave-1', curation_id: 'curation-1' },
      query: { page_size: '101' }
    } as any;

    await expect(handleListWaveCurationDropsV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 100'
    );
    expect(mockFindWaveCurationDrops).not.toHaveBeenCalled();
  });
});
