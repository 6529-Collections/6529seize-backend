const mockFindCuratedProfileWaveDrops = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findCuratedProfileWaveDrops: mockFindCuratedProfileWaveDrops
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { handleGetCuratedProfileWaveDropsV2 } from './get-curated-profile-wave-drops-v2.handler';

describe('handleGetCuratedProfileWaveDropsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindCuratedProfileWaveDrops.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { query: {} } as any;

    await expect(handleGetCuratedProfileWaveDropsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindCuratedProfileWaveDrops).toHaveBeenCalledWith(
      {
        page: 1,
        page_size: DEFAULT_PAGE_SIZE
      },
      {
        authenticationContext,
        timer
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = { query: { page: '2', page_size: '25' } } as any;

    await handleGetCuratedProfileWaveDropsV2(req);

    expect(mockFindCuratedProfileWaveDrops).toHaveBeenCalledWith(
      {
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
    const req = { query: { page_size: '2001' } } as any;

    await expect(handleGetCuratedProfileWaveDropsV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 2000'
    );
    expect(mockFindCuratedProfileWaveDrops).not.toHaveBeenCalled();
  });
});
