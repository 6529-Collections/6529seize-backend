const mockFindReactionsByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findReactionsByDropIdOrThrow: mockFindReactionsByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropV2ReactionsById } from './get-drop-v2-reactions-by-id.handler';

describe('handleGetDropV2ReactionsById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = [{ reaction: 'fire', reactors: [] }] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindReactionsByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('validates path params before calling the service', async () => {
    const req = { params: { id: 'drop-1' } } as any;

    await expect(handleGetDropV2ReactionsById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindReactionsByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
      timer,
      authenticationContext
    });
  });

  it('rejects invalid path params', async () => {
    const req = { params: {} } as any;

    await expect(handleGetDropV2ReactionsById(req)).rejects.toThrow(
      '"id" is required'
    );
    expect(mockFindReactionsByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
