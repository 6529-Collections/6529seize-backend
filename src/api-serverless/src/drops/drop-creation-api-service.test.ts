import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { DropType } from '@/entities/IDrop';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));

function makeService({
  currentHidden,
  refreshedHidden = currentHidden,
  updateChanged = true
}: {
  readonly currentHidden: boolean;
  readonly refreshedHidden?: boolean;
  readonly updateChanged?: boolean;
}) {
  const dropsService = {
    findDropByIdOrThrow: jest.fn().mockResolvedValue({
      id: 'drop-1',
      hide_link_preview: refreshedHidden
    })
  };
  const dropsDb = {
    findDropById: jest.fn().mockResolvedValue({
      id: 'drop-1',
      author_id: 'profile-1',
      hide_link_preview: currentHidden
    }),
    updateHideLinkPreview: jest.fn().mockResolvedValue(updateChanged)
  };
  const wsListenersNotifier = {
    notifyAboutDropUpdate: jest.fn()
  };
  const service = new DropCreationApiService(
    dropsService as never,
    dropsDb as never,
    {} as never,
    {} as never,
    {} as never,
    wsListenersNotifier as never,
    {} as never,
    {} as never,
    {} as never
  );
  const ctx = {
    authenticationContext: {
      getActingAsId: jest.fn().mockReturnValue('profile-1'),
      isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
    },
    timer: {
      start: jest.fn(),
      stop: jest.fn()
    }
  };

  return {
    ctx,
    dropsDb,
    dropsService,
    service,
    wsListenersNotifier
  };
}

describe('DropCreationApiService.toggleHideLinkPreview', () => {
  it('keeps legacy toggle behavior when no final state is provided', async () => {
    const { ctx, dropsDb, service, wsListenersNotifier } = makeService({
      currentHidden: false,
      refreshedHidden: true
    });

    await service.toggleHideLinkPreview({ dropId: 'drop-1' }, ctx as never);

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: true },
      ctx
    );
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      { id: 'drop-1', hide_link_preview: true },
      ctx
    );
  });

  it('sets previews hidden when an explicit hidden state is provided', async () => {
    const { ctx, dropsDb, service, wsListenersNotifier } = makeService({
      currentHidden: false,
      refreshedHidden: true
    });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: true },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: true },
      ctx
    );
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      { id: 'drop-1', hide_link_preview: true },
      ctx
    );
  });

  it('restores previews when an explicit visible state is provided', async () => {
    const { ctx, dropsDb, service, wsListenersNotifier } = makeService({
      currentHidden: true,
      refreshedHidden: false
    });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: false },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: false },
      ctx
    );
    expect(wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      { id: 'drop-1', hide_link_preview: false },
      ctx
    );
  });

  it('does not notify when explicit state already matches', async () => {
    const { ctx, dropsDb, service, wsListenersNotifier } = makeService({
      currentHidden: true,
      updateChanged: false
    });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: true },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: true },
      ctx
    );
    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
  });
});

describe('DropCreationApiService.createDrop', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('invalidates unread cache after the drop transaction commits', async () => {
    const connection = {} as any;
    const order: string[] = [];
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) => {
          order.push('transaction');
          const result = await callback(connection);
          order.push('committed');
          return result;
        }
      )
    };
    const dropsMappers = {
      createDropApiToUseCaseModel: jest.fn().mockReturnValue({
        wave_id: 'wave-1',
        drop_type: DropType.CHAT
      })
    };
    const createOrUpdateDrop = {
      preResolveIdentityNomination: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockImplementation(async () => {
        order.push('drop-written');
        return {
          drop_id: 'drop-1',
          pending_push_notification_ids: []
        };
      })
    };
    const dropPollsApiService = {
      createPollForDrop: jest.fn().mockResolvedValue(undefined)
    };
    const dropsService = {
      findDropByIdOrThrow: jest.fn().mockResolvedValue({
        id: 'drop-1',
        wave_id: 'wave-1'
      })
    };
    const wsListenersNotifier = {
      notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
    };
    const dropNftLinksDb = {
      findByDropId: jest.fn().mockResolvedValue([])
    };
    const service = new DropCreationApiService(
      dropsService as never,
      dropsDb as never,
      dropsMappers as never,
      createOrUpdateDrop as never,
      {} as never,
      wsListenersNotifier as never,
      dropNftLinksDb as never,
      {} as never,
      dropPollsApiService as never
    );
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
    (invalidateWaveUnreadCacheForWave as jest.Mock).mockImplementationOnce(
      async () => {
        order.push('unread-cache-invalidated');
      }
    );

    await service.createDrop(
      {
        createDropRequest: {} as never,
        authorId: 'author-profile',
        representativeId: 'author-profile'
      },
      { timer: undefined } as never
    );

    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledWith('wave-1');
    expect(order).toEqual([
      'transaction',
      'drop-written',
      'committed',
      'unread-cache-invalidated'
    ]);
  });
});

describe('DropCreationApiService.deleteDropById', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests async drop metric and score refresh after the delete transaction commits', async () => {
    const connection = {} as any;
    const deleteResponse = {
      id: 'drop-1',
      serial_no: 7,
      visibility_group_id: 'group-1',
      wave_id: 'wave-1'
    };
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback(connection)
      )
    };
    const deleteDrop = {
      execute: jest.fn().mockResolvedValue(deleteResponse)
    };
    const wsListenersNotifier = {
      notifyAboutDropDelete: jest.fn().mockResolvedValue(undefined)
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      {} as never,
      {} as never,
      deleteDrop as never,
      wsListenersNotifier as never,
      {} as never,
      {} as never,
      {} as never
    );
    const requestWaveDropMetricsRefreshSpy = jest
      .spyOn(
        waveDropMetricsRefreshService,
        'requestWaveDropMetricsRefreshBestEffort'
      )
      .mockResolvedValue(undefined);
    const requestWaveScoreRefreshSpy = jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      },
      timer: {
        start: jest.fn(),
        stop: jest.fn()
      }
    };

    await service.deleteDropById({ id: 'drop-1' }, ctx as never);

    expect(deleteDrop.execute).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        deleter_identity: 'profile-1',
        deleter_id: 'profile-1',
        deletion_purpose: 'DELETE'
      },
      { timer: ctx.timer, connection }
    );
    expect(requestWaveDropMetricsRefreshSpy).toHaveBeenCalledWith(
      ['wave-1'],
      'DROP_DELETED',
      {
        timer: ctx.timer,
        authenticationContext: ctx.authenticationContext
      }
    );
    expect(requestWaveScoreRefreshSpy).toHaveBeenCalledWith(
      ['wave-1'],
      'DROP_DELETED',
      {
        timer: ctx.timer,
        authenticationContext: ctx.authenticationContext
      }
    );
    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledWith('wave-1');
    expect(wsListenersNotifier.notifyAboutDropDelete).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        drop_serial: 7,
        wave_id: 'wave-1'
      },
      'group-1',
      {
        timer: ctx.timer,
        authenticationContext: ctx.authenticationContext
      }
    );
  });
});
