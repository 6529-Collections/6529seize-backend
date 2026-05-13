const mockFindPartByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findPartByDropIdOrThrow: mockFindPartByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropV2PartById } from './get-drop-v2-part-by-id.handler';

describe('handleGetDropV2PartById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { part_no: 2, content: 'part content' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindPartByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('validates path params before calling the service', async () => {
    const req = { params: { id: 'drop-1', part_no: '2' } } as any;

    await expect(handleGetDropV2PartById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindPartByDropIdOrThrow).toHaveBeenCalledWith('drop-1', 2, {
      timer,
      authenticationContext
    });
  });

  it('rejects invalid path params', async () => {
    const req = { params: { id: 'drop-1', part_no: '0' } } as any;

    await expect(handleGetDropV2PartById(req)).rejects.toThrow(
      '"part_no" must be greater than or equal to 1'
    );
    expect(mockFindPartByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
