import { AuthenticationContext } from '@/auth-context';
import { NotFoundException } from '@/exceptions';
import { WaveRepOverviewApiService } from './wave-rep-overview.api.service';

function makeWave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    visibility_group_id: null,
    parent_wave_id: null,
    ...overrides
  };
}

function createService() {
  const waveRepOverviewDb = {
    getWaveRepOverviewStats: jest.fn().mockResolvedValue({
      total_rep: '10',
      positive_rep: '12',
      negative_rep: '-2',
      authenticated_user_contribution: null,
      contributor_count: '2'
    }),
    getWaveRepContributorsPage: jest.fn().mockResolvedValue({
      page: 1,
      next: false,
      data: []
    }),
    getWaveRepCategoriesPage: jest.fn(),
    getTopWaveRepContributorsByCategories: jest.fn()
  };
  const wavesApiDb = {
    findWaveById: jest.fn().mockResolvedValue(makeWave())
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const identityFetcher = {
    getOverviewsByIds: jest.fn().mockResolvedValue({})
  };

  return {
    service: new WaveRepOverviewApiService(
      waveRepOverviewDb as any,
      wavesApiDb as any,
      userGroupsService as any,
      identityFetcher as any
    ),
    waveRepOverviewDb,
    wavesApiDb,
    userGroupsService
  };
}

describe('WaveRepOverviewApiService', () => {
  it('does not expose overview for a private wave to an ineligible viewer', async () => {
    const { service, wavesApiDb, waveRepOverviewDb } = createService();
    wavesApiDb.findWaveById.mockResolvedValue(
      makeWave({ visibility_group_id: 'private-group' })
    );

    await expect(
      service.getOverview({ waveId: 'wave-1', page: 1, page_size: 5 }, {})
    ).rejects.toThrow(NotFoundException);

    expect(waveRepOverviewDb.getWaveRepOverviewStats).not.toHaveBeenCalled();
    expect(waveRepOverviewDb.getWaveRepContributorsPage).not.toHaveBeenCalled();
  });

  it('returns overview for a private wave to an eligible viewer', async () => {
    const { service, wavesApiDb, userGroupsService } = createService();
    wavesApiDb.findWaveById.mockResolvedValue(
      makeWave({ visibility_group_id: 'private-group' })
    );
    userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([
      'private-group'
    ]);

    await expect(
      service.getOverview(
        { waveId: 'wave-1', page: 1, page_size: 5 },
        {
          authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
        }
      )
    ).resolves.toEqual({
      total_rep: 10,
      positive_rep: 12,
      negative_rep: -2,
      authenticated_user_contribution: null,
      contributor_count: 2,
      contributors: {
        page: 1,
        next: false,
        data: []
      }
    });
  });
});
