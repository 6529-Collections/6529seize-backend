import { AuthenticationContext } from '@/auth-context';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { BadRequestException } from '@/exceptions';
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
    curatedDropEntities = [],
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
    curatedDropEntities?: Record<string, unknown>[];
    wave?: Record<string, unknown> | null;
  } = {}) {
    const dropsDb = {
      findLatestDrops: jest.fn().mockResolvedValue([]),
      findLatestDropsSimple: jest.fn().mockResolvedValue([]),
      findDropsByCurationPriorityOrder: jest
        .fn()
        .mockResolvedValue(curatedDropEntities),
      findLightDropIdsByWave: jest.fn().mockResolvedValue([]),
      findVisibleLightDropIds: jest.fn().mockResolvedValue([]),
      findLightDropsByIds: jest.fn().mockResolvedValue([])
    };
    const dropsMappers = {
      convertToDropFulls: jest.fn().mockResolvedValue([]),
      convertToDropsWithoutWaves: jest
        .fn()
        .mockImplementation(async (entities) => entities)
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
      dropsMappers,
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
          curation_name: null,
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
          curation_name: null,
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

  it('rejects latest drop filtering when the curation wave is not readable', async () => {
    const { service, dropsDb, ctx } = createService({
      wave: {
        id: 'wave-1',
        name: 'Private Wave',
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
        visibility_group_id: 'private-group',
        admin_drop_deletion_enabled: false,
        forbid_negative_votes: false,
        time_lock_ms: null
      }
    });

    await expect(
      service.findLatestDrops(
        {
          amount: 10,
          group_id: null,
          serial_no_less_than: null,
          wave_id: null,
          curation_id: 'curation-1',
          curation_name: null,
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

  it('passes curation name filters into latest drops without resolving a single wave', async () => {
    const { service, dropsDb, curationsDb, ctx } = createService();

    await expect(
      service.findLatestDrops(
        {
          amount: 10,
          group_id: null,
          serial_no_less_than: null,
          wave_id: null,
          curation_id: null,
          curation_name: ' Art ',
          author_id: null,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      )
    ).resolves.toEqual([]);

    expect(curationsDb.findWaveCurationById).not.toHaveBeenCalled();
    expect(dropsDb.findLatestDrops).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: null,
        curation_id: null,
        curation_name: 'Art'
      }),
      ctx
    );
  });

  it('rejects latest drop filtering by curation id and name together', async () => {
    const { service, dropsDb, ctx } = createService();

    await expect(
      service.findLatestDrops(
        {
          amount: 10,
          group_id: null,
          serial_no_less_than: null,
          wave_id: null,
          curation_id: 'curation-1',
          curation_name: 'Art',
          author_id: null,
          include_replies: false,
          drop_type: null,
          ids: null,
          contains_media: false
        },
        ctx
      )
    ).rejects.toThrow(`Use either curation_id or curation_name, not both`);

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

  it('returns curation drops with no-count pagination', async () => {
    const { service, dropsDb, dropsMappers, ctx } = createService({
      curatedDropEntities: [
        { id: 'drop-1', drop_priority_order: 1 },
        { id: 'drop-2', drop_priority_order: 2 },
        { id: 'drop-3', drop_priority_order: 3 }
      ]
    });
    dropsMappers.convertToDropsWithoutWaves.mockResolvedValue([
      { id: 'drop-1' },
      { id: 'drop-2' }
    ]);

    await expect(
      service.findWaveCurationDrops(
        {
          wave_id: 'wave-1',
          curation_id: 'curation-1',
          page: 2,
          page_size: 2
        },
        ctx
      )
    ).resolves.toEqual({
      data: [
        { id: 'drop-1', drop_priority_order: 1 },
        { id: 'drop-2', drop_priority_order: 2 }
      ],
      page: 2,
      next: true
    });

    expect(dropsDb.findDropsByCurationPriorityOrder).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        curation_id: 'curation-1',
        limit: 3,
        offset: 2
      },
      ctx
    );
    expect(dropsMappers.convertToDropsWithoutWaves).toHaveBeenCalledWith(
      [
        { id: 'drop-1', drop_priority_order: 1 },
        { id: 'drop-2', drop_priority_order: 2 }
      ],
      ctx
    );
  });

  it.each([
    { page: 0, page_size: 2 },
    { page: 1, page_size: 0 }
  ])(
    'rejects invalid curation drops pagination before querying drops',
    async ({ page, page_size }) => {
      const { service, dropsDb, dropsMappers, curationsDb, ctx } =
        createService();

      await expect(
        service.findWaveCurationDrops(
          {
            wave_id: 'wave-1',
            curation_id: 'curation-1',
            page,
            page_size
          },
          ctx
        )
      ).rejects.toThrow(BadRequestException);

      expect(curationsDb.findWaveCurationById).not.toHaveBeenCalled();
      expect(dropsDb.findDropsByCurationPriorityOrder).not.toHaveBeenCalled();
      expect(dropsMappers.convertToDropsWithoutWaves).not.toHaveBeenCalled();
    }
  );

  it('rejects curation drops when the curation is not in the requested wave', async () => {
    const { service, dropsDb, ctx } = createService({
      curation: {
        id: 'curation-1',
        wave_id: 'wave-2',
        community_group_id: 'community-group-1'
      }
    });

    await expect(
      service.findWaveCurationDrops(
        {
          wave_id: 'wave-1',
          curation_id: 'curation-1',
          page: 1,
          page_size: 2
        },
        ctx
      )
    ).rejects.toThrow(`Curation curation-1 not found`);

    expect(dropsDb.findDropsByCurationPriorityOrder).not.toHaveBeenCalled();
  });
});
