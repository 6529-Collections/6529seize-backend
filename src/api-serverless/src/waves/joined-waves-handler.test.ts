jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('@/api/waves/joined-waves.api.service', () => ({
  joinedWavesApiService: { findPage: jest.fn() }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { GetJoinedWavesRequest } from '@/api/generated/routes/operations';
import { joinedWavesApiService } from './joined-waves.api.service';
import { handleGetJoinedWaves } from './joined-waves.handler';

const request = (query: object = {}) => ({ query }) as GetJoinedWavesRequest;

beforeEach(() => {
  jest.clearAllMocks();
});

it('defaults page size and passes the authenticated request context', async () => {
  jest
    .mocked(getAuthenticationContext)
    .mockResolvedValue(
      {} as Awaited<ReturnType<typeof getAuthenticationContext>>
    );
  jest.mocked(joinedWavesApiService.findPage).mockResolvedValue({
    data: [],
    next_cursor: null,
    snapshot_expires_at: 1000
  });
  await expect(handleGetJoinedWaves(request())).resolves.toEqual({
    data: [],
    next_cursor: null,
    snapshot_expires_at: 1000
  });
  expect(joinedWavesApiService.findPage).toHaveBeenCalledWith(
    { page_size: 20 },
    expect.objectContaining({ authenticationContext: {} })
  );
});

it.each([
  { page_size: 0 },
  { page_size: 101 },
  { page_size: 1.5 },
  { cursor: '' },
  { cursor: 'a'.repeat(257) },
  { page: 2 }
])('rejects invalid requests before reading snapshots: %j', async (query) => {
  await expect(handleGetJoinedWaves(request(query))).rejects.toThrow();
  expect(joinedWavesApiService.findPage).not.toHaveBeenCalled();
});
