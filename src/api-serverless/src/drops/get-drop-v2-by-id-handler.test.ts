const mockFindWithWaveByIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findWithWaveByIdOrThrow: mockFindWithWaveByIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropV2ById } from './get-drop-v2-by-id.handler';

describe('handleGetDropV2ById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { drop: { id: 'drop-1' }, wave: { id: 'wave-1' } } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindWithWaveByIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('validates path params before calling the service', async () => {
    const req = { params: { id: 'drop-1' } } as any;

    await expect(handleGetDropV2ById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindWithWaveByIdOrThrow).toHaveBeenCalledWith('drop-1', {
      timer,
      authenticationContext
    });
  });

  it('rejects invalid path params', async () => {
    const req = { params: {} } as any;

    await expect(handleGetDropV2ById(req)).rejects.toThrow('"id" is required');
    expect(mockFindWithWaveByIdOrThrow).not.toHaveBeenCalled();
  });
});
