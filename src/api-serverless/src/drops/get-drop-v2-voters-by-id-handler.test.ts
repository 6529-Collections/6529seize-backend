const mockFindVotersByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findVotersByDropIdOrThrow: mockFindVotersByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { PageSortDirection } from '@/api/page-request';
import { handleGetDropV2VotersById } from './get-drop-v2-voters-by-id.handler';

describe('handleGetDropV2VotersById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], count: 0, page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindVotersByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { params: { id: 'drop-1' }, query: {} } as any;

    await expect(handleGetDropV2VotersById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindVotersByDropIdOrThrow).toHaveBeenCalledWith(
      'drop-1',
      {
        page_size: 20,
        page: 1,
        sort_direction: PageSortDirection.DESC
      },
      {
        timer,
        authenticationContext
      }
    );
  });

  it('normalizes query params before calling the service', async () => {
    const req = {
      params: { id: 'drop-1' },
      query: {
        page_size: '50',
        page: '2',
        sort_direction: PageSortDirection.ASC
      }
    } as any;

    await handleGetDropV2VotersById(req);

    expect(mockFindVotersByDropIdOrThrow).toHaveBeenCalledWith(
      'drop-1',
      {
        page_size: 50,
        page: 2,
        sort_direction: PageSortDirection.ASC
      },
      {
        timer,
        authenticationContext
      }
    );
  });

  it('rejects invalid query params', async () => {
    const req = {
      params: { id: 'drop-1' },
      query: { page_size: '101' }
    } as any;

    await expect(handleGetDropV2VotersById(req)).rejects.toThrow(
      '"page_size" must be less than or equal to 100'
    );
    expect(mockFindVotersByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
