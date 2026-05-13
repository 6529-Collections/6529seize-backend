const mockFindMetadataByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findMetadataByDropIdOrThrow: mockFindMetadataByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleGetDropV2MetadataById } from './get-drop-v2-metadata-by-id.handler';

describe('handleGetDropV2MetadataById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = [{ data_key: 'artist', data_value: '6529er' }] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindMetadataByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('validates path params before calling the service', async () => {
    const req = { params: { id: 'drop-1' } } as any;

    await expect(handleGetDropV2MetadataById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindMetadataByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
      timer,
      authenticationContext
    });
  });

  it('rejects invalid path params', async () => {
    const req = { params: {} } as any;

    await expect(handleGetDropV2MetadataById(req)).rejects.toThrow(
      '"id" is required'
    );
    expect(mockFindMetadataByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
