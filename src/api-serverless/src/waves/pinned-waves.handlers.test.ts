const mockFindPositions = jest.fn();
const mockMapWaves = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: async () => ({})
}));
jest.mock('@/api/waves/wave-access.helpers', () => ({
  getAuthenticatedNonProxyProfileIdOrThrow: () => 'profile-1'
}));
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: { getGroupsUserIsEligibleFor: async () => ['group-1'] }
}));
jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: {
    executeNativeQueriesInTransaction: async (
      fn: (connection: unknown) => Promise<unknown>
    ) => fn({}),
    findPinnedWavePositions: (...args: unknown[]) => mockFindPositions(...args),
    findWavesByIds: async (ids: string[]) =>
      ids.map((id) => ({
        id,
        parent_wave_id: null,
        is_direct_message: false
      }))
  }
}));
jest.mock('@/api/waves/api-wave-overview.mapper', () => ({
  apiWaveOverviewMapper: {
    mapWaves: (...args: unknown[]) => mockMapWaves(...args)
  }
}));

import { handleGetPinnedWaves } from './pinned-waves.handlers';

describe('GET /v2/waves/pinned', () => {
  it('gives each pin its saved position, null where none is saved, in saved order', async () => {
    mockFindPositions.mockResolvedValue([
      { wave_id: 'wave-b', position: 3 },
      { wave_id: 'wave-a', position: '1024' },
      { wave_id: 'wave-c', position: null }
    ]);
    mockMapWaves.mockImplementation(async (waves: { id: string }[]) =>
      Object.fromEntries(
        waves.map((wave) => [
          wave.id,
          { id: wave.id, context_profile_context: { pinned: false } }
        ])
      )
    );
    const answer = await handleGetPinnedWaves({} as never);
    expect(
      answer.map((wave) => [
        wave.id,
        wave.context_profile_context?.pinned,
        wave.context_profile_context?.pinned_position
      ])
    ).toEqual([
      ['wave-b', true, 3],
      ['wave-a', true, 1024],
      ['wave-c', true, null]
    ]);
  });
});
