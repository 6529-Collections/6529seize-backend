const mockFindBoostsByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findBoostsByDropIdOrThrow: mockFindBoostsByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropV2BoostsById } from './get-drop-v2-boosts-by-id.handler';

describe('handleGetDropV2BoostsById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = [{ boosted_at: 123 }] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindBoostsByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('validates path params before calling the service', async () => {
    const req = { params: { id: 'drop-1' } } as any;

    await expect(handleGetDropV2BoostsById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindBoostsByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
      timer,
      authenticationContext
    });
  });

  it('rejects invalid path params', async () => {
    const req = { params: {} } as any;

    await expect(handleGetDropV2BoostsById(req)).rejects.toThrow(
      '"id" is required'
    );
    expect(mockFindBoostsByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
