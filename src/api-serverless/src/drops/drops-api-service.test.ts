import { AuthenticationContext } from '@/auth-context';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { wavesApiDb } from '../waves/waves.api.db';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { DropsApiService } from './drops.api.service';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DropsApiService', () => {
  function createService({
    curation = {
      id: 'curation-1',
      wave_id: 'wave-1',
      community_group_id: 'community-group-1'
    },
    wave = {
      id: 'wave-1',
      name: 'Wave 1',
      picture: null,
      description_drop_id: 'description-drop-1',
      last_drop_time: 1,
      submission_type: null,
      chat_enabled: false,
      chat_group_id: null,
      voting_group_id: null,
      participation_group_id: null,
      admin_group_id: null,
      voting_credit_type: 'TDH',
      voting_period_start: null,
      voting_period_end: null,
      visibility_group_id: null,
      admin_drop_deletion_enabled: false,
      forbid_negative_votes: false,
      time_lock_ms: null
    }
  }: {
    curation?: Record<string, unknown> | null;
    wave?: Record<string, unknown> | null;
  } = {}) {
    const dropsDb = {
      findLatestDrops: jest.fn().mockResolvedValue([]),
      findLatestDropsSimple: jest.fn().mockResolvedValue([])
    };
    const dropsMappers = {
      convertToDropFulls: jest.fn().mockResolvedValue([]),
      convertToDropsWithoutWaves: jest.fn().mockResolvedValue([])
    };
    const curationsDb = {
      findWaveCurationById: jest.fn().mockResolvedValue(curation)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue(wave as any);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set<string>());
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});

    return {
      service: new DropsApiService(
        dropsMappers as any,
        dropsDb as any,
        curationsDb as any,
        userGroupsService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      ),
      dropsDb,
      curationsDb,
      userGroupsService,
      ctx: {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      } as any
    };
  }

  it('constrains latest drop filtering to the curation wave and persisted membership', async () => {
    const { service, dropsDb, ctx } = createService();

    await expect(
      service.findLatestDrops(
        {
          amount: 10,
          group_id: null,
          serial_no_less_than: null,
          wave_id: null,
          curation_id: 'curation-1',
          author_id: null,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      )
    ).resolves.toEqual([]);

    expect(dropsDb.findLatestDrops).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        curation_id: 'curation-1'
      }),
      ctx
    );
  });

  it('rejects latest drop filtering when the curation does not exist', async () => {
    const { service, dropsDb, ctx } = createService({
      curation: null
    });

    await expect(
      service.findLatestDrops(
        {
          amount: 10,
          group_id: null,
          serial_no_less_than: null,
          wave_id: null,
          curation_id: 'curation-1',
          author_id: null,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      )
    ).rejects.toThrow(`Curation curation-1 not found`);

    expect(dropsDb.findLatestDrops).not.toHaveBeenCalled();
  });

  it('passes curation filters into wave drop feeds', async () => {
    const { service, dropsDb, ctx } = createService();

    await expect(
      service.findWaveDropsFeed(
        {
          wave_id: 'wave-1',
          drop_id: null,
          amount: 10,
          serial_no_limit: null,
          search_strategy: ApiDropSearchStrategy.Older,
          drop_type: null,
          curation_id: 'curation-1'
        },
        ctx
      )
    ).resolves.toEqual({
      drops: [],
      wave: expect.objectContaining({
        id: 'wave-1'
      })
    });

    expect(dropsDb.findLatestDropsSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        curation_id: 'curation-1'
      }),
      ctx
    );
  });
});
