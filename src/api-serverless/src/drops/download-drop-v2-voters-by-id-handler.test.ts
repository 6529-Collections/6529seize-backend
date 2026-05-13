const mockFindVotersCsvByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();
const mockReturnCSVResult = jest.fn();

jest.mock('@/api/api-helpers', () => ({
  returnCSVResult: mockReturnCSVResult
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findVotersCsvByDropIdOrThrow: mockFindVotersCsvByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleDownloadDropV2VotersById } from './download-drop-v2-voters-by-id.handler';

describe('handleDownloadDropV2VotersById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const voters = [{ handle: 'voter', level: 1, primary_address: '0x1' }] as any;
  const res = { marker: 'response' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindVotersCsvByDropIdOrThrow.mockResolvedValue(voters);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
    mockReturnCSVResult.mockResolvedValue(res);
  });

  it('validates path params before returning csv', async () => {
    const req = { params: { id: 'drop-1' } } as any;

    await expect(handleDownloadDropV2VotersById(req, res)).resolves.toBe(
      undefined
    );

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindVotersCsvByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
      timer,
      authenticationContext
    });
    expect(mockReturnCSVResult).toHaveBeenCalledWith(
      'drop-drop-1-votes',
      voters,
      res
    );
  });

  it('rejects invalid path params', async () => {
    const req = { params: {} } as any;

    await expect(handleDownloadDropV2VotersById(req, res)).rejects.toThrow(
      '"id" is required'
    );
    expect(mockFindVotersCsvByDropIdOrThrow).not.toHaveBeenCalled();
    expect(mockReturnCSVResult).not.toHaveBeenCalled();
  });
});
