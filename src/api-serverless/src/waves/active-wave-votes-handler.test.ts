const mockAuthentication = jest.fn();
const mockReadGroups = jest.fn();
const mockFind = jest.fn();
const mockMap = jest.fn();
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockAuthentication
}));
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {}
}));
jest.mock('@/api/waves/wave-access.helpers', () => ({
  getGroupsUserIsEligibleForReadContext: mockReadGroups
}));
jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: { findActiveTdhVotingWaves: mockFind }
}));
jest.mock('@/api/waves/api-wave-overview.mapper', () => ({
  apiWaveOverviewMapper: { mapWaves: mockMap }
}));
jest.mock('@/time', () => ({
  Timer: { getFromRequest: () => undefined },
  Time: { currentMillis: () => 1000 }
}));
import { handleGetActiveWaveVotes } from './active-wave-votes.handler';
import { GetActiveWaveVotesRequest } from '@/api/generated/routes/operations';
const request = (query: object = {}) =>
  ({ query }) as GetActiveWaveVotesRequest;

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthentication.mockResolvedValue({ role: 'viewer' });
  mockReadGroups.mockResolvedValue(['visible-group']);
  mockFind.mockResolvedValue({
    waves: [
      { id: 'vote', voting_period_end: '2000', next_decision_time: null }
    ],
    count: 21
  });
  mockMap.mockResolvedValue({ vote: { id: 'vote', name: 'Vote' } });
});

it('uses shared read access and maps deadlines with count-based pagination', async () => {
  const result = await handleGetActiveWaveVotes(request());
  expect(mockFind).toHaveBeenCalledWith(
    { eligibleGroups: ['visible-group'], now: 1000, limit: 20, offset: 0 },
    expect.objectContaining({ authenticationContext: { role: 'viewer' } })
  );
  expect(result).toEqual({
    data: [
      {
        wave: { id: 'vote', name: 'Vote' },
        voting_ends_at: 2000,
        next_decision_at: null
      }
    ],
    count: 21,
    page: 1,
    next: true
  });
});

it('returns a final empty page without inventing a next page', async () => {
  mockFind.mockResolvedValue({ waves: [], count: 21 });
  expect(
    await handleGetActiveWaveVotes(request({ page: '3', page_size: '20' }))
  ).toEqual({ data: [], count: 21, page: 3, next: false });
  expect(mockFind).toHaveBeenCalledWith(
    expect.objectContaining({ offset: 40 }),
    expect.anything()
  );
});

it.each([
  { page: '0' },
  { page: '1.5' },
  { page_size: '51' },
  { page_size: '-1' },
  { unexpected: 'value' }
])('rejects invalid pagination before reading data: %j', async (query) => {
  await expect(handleGetActiveWaveVotes(request(query))).rejects.toThrow();
  expect(mockFind).not.toHaveBeenCalled();
});
