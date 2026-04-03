import { AuthenticationContext } from '@/auth-context';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { WaveCreditType } from '@/entities/IWave';
import { DropsApiService } from './drops.api.service';

describe('DropsApiService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createService() {
    const dropsMappers = {
      convertToDropFulls: jest.fn().mockResolvedValue([]),
      convertToDropsWithoutWaves: jest.fn().mockResolvedValue([])
    };
    const dropsDb = {
      findLatestDrops: jest.fn().mockResolvedValue([{ id: 'drop-1' }]),
      getDropsByIds: jest.fn().mockResolvedValue([{ id: 'drop-1' }]),
      findLatestDropsSimple: jest.fn().mockResolvedValue([]),
      findLatestDropRepliesSimple: jest.fn().mockResolvedValue([]),
      findDropByIdWithEligibilityCheck: jest.fn(),
      getTraceForDrop: jest.fn().mockResolvedValue([])
    };
    const waveSelectionsDb = {
      findWaveSelectionsByWaveIds: jest.fn().mockResolvedValue([])
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };

    return {
      service: new DropsApiService(
        dropsMappers as any,
        dropsDb as any,
        {} as any,
        waveSelectionsDb as any,
        userGroupsService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      ),
      dropsMappers,
      dropsDb,
      waveSelectionsDb
    };
  }

  function createWave() {
    return {
      id: 'wave-1',
      name: 'Wave 1',
      picture: null,
      description_drop_id: 'drop-1',
      last_drop_time: 1,
      submission_type: null,
      chat_enabled: false,
      chat_group_id: null,
      voting_group_id: null,
      participation_group_id: null,
      admin_group_id: null,
      voting_credit_type: WaveCreditType.TDH,
      voting_period_start: null,
      voting_period_end: null,
      visibility_group_id: null,
      admin_drop_deletion_enabled: false,
      forbid_negative_votes: false
    };
  }

  it('forwards ctx.connection when expanding latest drops', async () => {
    const { service, dropsMappers } = createService();
    const connection = { connection: { id: 'tx' } } as any;

    await service.findLatestDrops(
      {
        amount: 10,
        group_id: null,
        wave_id: null,
        selection_id: null,
        serial_no_less_than: null,
        author_id: null,
        include_replies: true,
        drop_type: null,
        ids: null,
        contains_media: false
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        connection
      } as any
    );

    expect(dropsMappers.convertToDropFulls).toHaveBeenCalledWith(
      expect.objectContaining({
        dropEntities: [{ id: 'drop-1' }]
      }),
      connection
    );
  });

  it('forwards the provided connection when expanding drops by id', async () => {
    const { service, dropsMappers } = createService();
    const connection = { connection: { id: 'tx' } } as any;

    await service.findDropsByIds(
      ['drop-1'],
      AuthenticationContext.fromProfileId('profile-1'),
      connection
    );

    expect(dropsMappers.convertToDropFulls).toHaveBeenCalledWith(
      expect.objectContaining({
        dropEntities: [{ id: 'drop-1' }]
      }),
      connection
    );
  });

  it('forwards selection_id when loading wave drops', async () => {
    const { service, dropsDb, waveSelectionsDb } = createService();

    jest
      .spyOn(wavesApiDb, 'findWaveById')
      .mockResolvedValue(createWave() as any);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set<string>());
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});

    await service.findWaveDropsFeed(
      {
        wave_id: 'wave-1',
        drop_id: null,
        amount: 10,
        serial_no_limit: 42,
        search_strategy: ApiDropSearchStrategy.Older,
        drop_type: null,
        selection_id: 'selection-1'
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined,
        connection: undefined
      } as any
    );

    expect(waveSelectionsDb.findWaveSelectionsByWaveIds).toHaveBeenCalledWith(
      ['wave-1'],
      undefined
    );
    expect(dropsDb.findLatestDropsSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        wave_id: 'wave-1',
        selection_id: 'selection-1'
      }),
      expect.anything()
    );
  });

  it('forwards selection_id when loading replies in a wave thread', async () => {
    const { service, dropsDb, dropsMappers } = createService();
    const rootDrop = { id: 'drop-1', wave_id: 'wave-1' };

    jest
      .spyOn(wavesApiDb, 'findWaveById')
      .mockResolvedValue(createWave() as any);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set<string>());
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});
    dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(rootDrop);
    dropsMappers.convertToDropsWithoutWaves
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'drop-1' }]);

    await service.findWaveDropsFeed(
      {
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        amount: 10,
        serial_no_limit: 42,
        search_strategy: ApiDropSearchStrategy.Older,
        drop_type: null,
        selection_id: 'selection-1'
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined,
        connection: undefined
      } as any
    );

    expect(dropsDb.findLatestDropRepliesSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        drop_id: 'drop-1',
        selection_id: 'selection-1'
      }),
      expect.anything()
    );
  });
});
