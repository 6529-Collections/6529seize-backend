const mockFindDrops = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findDrops: mockFindDrops
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropsV2 } from './get-drops-v2.handler';

describe('handleGetDropsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindDrops.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { query: {} } as any;

    await expect(handleGetDropsV2(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindDrops).toHaveBeenCalledWith(
      {
        parent_drop_id: null,
        page_size: 50,
        page: 1
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
        parent_drop_id: '',
        page_size: '25',
        page: '2'
      }
    } as any;

    await handleGetDropsV2(req);

    expect(mockFindDrops).toHaveBeenCalledWith(
      {
        parent_drop_id: null,
        page_size: 25,
        page: 2
      },
      {
        timer,
        authenticationContext
      }
    );
  });

  it('rejects invalid query params', async () => {
    const req = { query: { page_size: '101' } } as any;

    await expect(handleGetDropsV2(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 100'
    );
    expect(mockFindDrops).not.toHaveBeenCalled();
  });
});
