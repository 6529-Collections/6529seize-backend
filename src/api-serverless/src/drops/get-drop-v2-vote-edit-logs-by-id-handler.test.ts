const mockFindVoteEditLogsByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findVoteEditLogsByDropIdOrThrow: mockFindVoteEditLogsByDropIdOrThrow
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { PageSortDirection } from '@/api/page-request';
import { handleGetDropV2VoteEditLogsById } from './get-drop-v2-vote-edit-logs-by-id.handler';

describe('handleGetDropV2VoteEditLogsById', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = [{ id: 'log-1' }] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindVoteEditLogsByDropIdOrThrow.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  it('applies query defaults before calling the service', async () => {
    const req = { params: { id: 'drop-1' }, query: {} } as any;

    await expect(handleGetDropV2VoteEditLogsById(req)).resolves.toBe(result);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockFindVoteEditLogsByDropIdOrThrow).toHaveBeenCalledWith(
      'drop-1',
      {
        offset: 0,
        limit: 20,
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
        offset: '10',
        limit: '50',
        sort_direction: PageSortDirection.ASC
      }
    } as any;

    await handleGetDropV2VoteEditLogsById(req);

    expect(mockFindVoteEditLogsByDropIdOrThrow).toHaveBeenCalledWith(
      'drop-1',
      {
        offset: 10,
        limit: 50,
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
      query: { limit: '101' }
    } as any;

    await expect(handleGetDropV2VoteEditLogsById(req)).rejects.toThrow(
      '"limit" must be less than or equal to 100'
    );
    expect(mockFindVoteEditLogsByDropIdOrThrow).not.toHaveBeenCalled();
  });
});
