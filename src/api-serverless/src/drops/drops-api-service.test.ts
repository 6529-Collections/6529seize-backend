import { AuthenticationContext } from '@/auth-context';
import { PageSortDirection } from '@/api/page-request';
import { DropsApiService } from '@/api/drops/drops.api.service';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { LeaderboardSort } from '@/drops/drops.db';
import { WaveCreditType, WaveType } from '@/entities/IWave';

describe('DropsApiService.findLeaderboard', () => {
  const dropsMappers = {
    convertToDropsWithoutWaves: jest.fn()
  };
  const dropsDb = {
    countParticipatoryDrops: jest.fn(),
    findWaveParticipationDropsOrderedByCreatedAt: jest.fn()
  };
  const curationsDb = {
    findWaveCurationGroupById: jest.fn()
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn(),
    findIdentitiesInGroups: jest.fn()
  };
  const service = new DropsApiService(
    dropsMappers as any,
    dropsDb as any,
    curationsDb as any,
    userGroupsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  const leaderboardParams = {
    wave_id: 'wave-1',
    page_size: 25,
    page: 1,
    sort_direction: PageSortDirection.ASC,
    sort: LeaderboardSort.CREATED_AT,
    curated_by_group: null,
    unvoted_by_me: true,
    price_currency: null,
    min_price: null,
    max_price: null
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects unvoted_by_me for unauthenticated users before loading leaderboard data', async () => {
    const result = service.findLeaderboard(leaderboardParams, {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    await expect(result).rejects.toMatchObject({
      message: 'User must be authenticated to use unvoted_by_me'
    });

    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
  });

  it('passes the authenticated voter id into leaderboard count and fetch queries', async () => {
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      name: 'Wave',
      picture: null,
      description_drop_id: 'drop-1',
      last_drop_time: 123,
      visibility_group_id: null,
      participation_group_id: null,
      admin_group_id: null,
      chat_group_id: null,
      voting_group_id: null,
      admin_drop_deletion_enabled: false,
      forbid_negative_votes: false,
      voting_period_start: null,
      voting_period_end: null,
      voting_credit_type: WaveCreditType.TDH,
      time_lock_ms: null,
      type: WaveType.RANK,
      chat_enabled: true
    } as any);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set());
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});

    userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    dropsDb.countParticipatoryDrops.mockResolvedValue(1);
    dropsDb.findWaveParticipationDropsOrderedByCreatedAt.mockResolvedValue([
      { id: 'drop-1' }
    ]);
    dropsMappers.convertToDropsWithoutWaves.mockResolvedValue([
      { id: 'drop-1' }
    ]);

    const authenticationContext =
      AuthenticationContext.fromProfileId('profile-1');

    const result = await service.findLeaderboard(leaderboardParams, {
      authenticationContext
    });

    expect(dropsDb.countParticipatoryDrops).toHaveBeenCalledWith(
      leaderboardParams,
      expect.objectContaining({ authenticationContext }),
      null,
      'profile-1'
    );
    expect(
      dropsDb.findWaveParticipationDropsOrderedByCreatedAt
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        unvoted_by_me: true,
        voter_id: 'profile-1'
      }),
      expect.objectContaining({ authenticationContext })
    );
    expect(result.count).toBe(1);
  });
});
