import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { DropType } from '@/entities/IDrop';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { DbPoolName } from '@/db-query.options';
import { helpBotDailyActivityCreditQueueService } from '@/help-bot/help-bot-daily-activity-credit-queue.service';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn().mockResolvedValue(undefined)
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
  beforeEach(() => {
    (sendIdentityPushNotifications as jest.Mock).mockResolvedValue(undefined);
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'enqueueRequest')
      .mockResolvedValue(false);
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'sendWakeupBestEffort')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it.each([true, false])(
    'persists explicit hideLinkPreview=%s before invalidating unread cache',
    async (hideLinkPreview) => {
      const connection = {} as any;
      const order: string[] = [];
      (
        helpBotDailyActivityCreditQueueService.enqueueRequest as jest.Mock
      ).mockImplementationOnce(async () => {
        order.push('daily-credit-request-written');
        return true;
      });
      (
        helpBotDailyActivityCreditQueueService.sendWakeupBestEffort as jest.Mock
      ).mockImplementationOnce(async () => {
        order.push('daily-credit-wakeup-sent');
      });
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
          createDropRequest: { hide_link_preview: hideLinkPreview } as never,
          authorId: 'author-profile',
          representativeId: 'author-profile',
          hideLinkPreview,
          requestDailyActivityCredit: true
        },
        { timer: undefined } as never
      );

      expect(dropsMappers.createDropApiToUseCaseModel).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            hide_link_preview: hideLinkPreview
          })
        })
      );
      expect(createOrUpdateDrop.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          hide_link_preview: hideLinkPreview
        }),
        false,
        expect.anything()
      );
      expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledWith('wave-1');
      expect(
        helpBotDailyActivityCreditQueueService.enqueueRequest
      ).toHaveBeenCalledWith(
        { profileId: 'author-profile' },
        { timer: undefined, connection }
      );
      expect(order).toEqual([
        'transaction',
        'drop-written',
        'daily-credit-request-written',
        'committed',
        'daily-credit-wakeup-sent',
        'unread-cache-invalidated'
      ]);
    }
  );

  it('broadcasts the writer-authoritative unread state after a direct-message drop commits', async () => {
    const connection = {} as any;
    const order: string[] = [];
    const dmUnreadState = {
      profile_id: 'reader-profile',
      wave_id: 'wave-1',
      unread_count: 1,
      first_unread_drop_serial_no: 42,
      latest_drop_serial_no: 42,
      latest_read_serial_no: 41,
      version: 7
    };
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) => {
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
          pending_push_notification_ids: [],
          dm_unread_recipient_ids: ['reader-profile']
        };
      })
    };
    const dropsService = {
      findDropByIdOrThrow: jest.fn().mockResolvedValue({ id: 'drop-1' })
    };
    const wsListenersNotifier = {
      notifyAboutDropUpdate: jest.fn().mockImplementation(async () => {
        order.push('drop-broadcast');
      }),
      findConnectedNotificationRecipients: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', identityId: 'reader-profile' }
        ]),
      notifyAboutDmUnreadStateChanged: jest
        .fn()
        .mockImplementation(async () => {
          order.push('unread-broadcast');
        })
    };
    const wavesApiDb = {
      findDmUnreadConversationStatesForIdentities: jest
        .fn()
        .mockImplementation(async () => {
          order.push('unread-state-read');
          return [dmUnreadState];
        })
    };
    const service = new DropCreationApiService(
      dropsService as never,
      dropsDb as never,
      dropsMappers as never,
      createOrUpdateDrop as never,
      {} as never,
      wsListenersNotifier as never,
      { findByDropId: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { createPollForDrop: jest.fn().mockResolvedValue(undefined) } as never,
      wavesApiDb as never
    );
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);

    await service.createDrop(
      {
        createDropRequest: {} as never,
        authorId: 'author-profile',
        representativeId: 'author-profile'
      },
      { timer: undefined } as never
    );

    expect(
      wavesApiDb.findDmUnreadConversationStatesForIdentities
    ).toHaveBeenCalledWith(
      { identityIds: ['reader-profile'], waveIds: ['wave-1'] },
      expect.objectContaining({ timer: undefined }),
      DbPoolName.WRITE
    );
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledWith(
      [dmUnreadState],
      [{ connectionId: 'connection-1', identityId: 'reader-profile' }]
    );
    expect(
      helpBotDailyActivityCreditQueueService.enqueueRequest
    ).not.toHaveBeenCalled();
    expect(order).toEqual([
      'drop-written',
      'committed',
      'drop-broadcast',
      'unread-state-read',
      'unread-broadcast'
    ]);
  });

  it('waits for pending push notifications to be enqueued before resolving', async () => {
    const connection = {} as any;
    let resolvePush!: () => void;
    const pushStarted = new Promise<void>((resolveStarted) => {
      (sendIdentityPushNotifications as jest.Mock).mockImplementationOnce(
        () => {
          resolveStarted();
          return new Promise<void>((resolve) => {
            resolvePush = resolve;
          });
        }
      );
    });
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback(connection)
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
      execute: jest.fn().mockResolvedValue({
        drop_id: 'drop-1',
        pending_push_notification_ids: [3711]
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

    let resolved = false;
    const createDrop = service
      .createDrop(
        {
          createDropRequest: {} as never,
          authorId: 'author-profile',
          representativeId: 'author-profile'
        },
        { timer: undefined } as never
      )
      .then((drop) => {
        resolved = true;
        return drop;
      });

    await pushStarted;
    await Promise.resolve();

    expect(sendIdentityPushNotifications).toHaveBeenCalledWith([3711]);
    expect(resolved).toBe(false);

    resolvePush();

    await expect(createDrop).resolves.toEqual({
      id: 'drop-1',
      wave_id: 'wave-1'
    });
    expect(resolved).toBe(true);
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
      wave_id: 'wave-1',
      dm_unread_recipient_ids: ['reader-1']
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
      notifyAboutDropDelete: jest.fn().mockResolvedValue(undefined),
      findConnectedNotificationRecipients: jest
        .fn()
        .mockResolvedValue([
          { connectionId: 'connection-1', identityId: 'reader-1' }
        ]),
      notifyAboutDmUnreadStateChanged: jest.fn().mockResolvedValue(undefined)
    };
    const dmUnreadState = {
      profile_id: 'reader-1',
      wave_id: 'wave-1',
      unread_count: 0,
      first_unread_drop_serial_no: null,
      latest_drop_serial_no: 6,
      latest_read_serial_no: 0,
      version: 2
    };
    const wavesApiDb = {
      findDmUnreadConversationStatesForIdentities: jest
        .fn()
        .mockResolvedValue([dmUnreadState])
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
      {} as never,
      wavesApiDb as never
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
    expect(
      wavesApiDb.findDmUnreadConversationStatesForIdentities
    ).toHaveBeenCalledWith(
      { identityIds: ['reader-1'], waveIds: ['wave-1'] },
      expect.objectContaining({
        authenticationContext: ctx.authenticationContext
      }),
      DbPoolName.WRITE
    );
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledWith(
      [dmUnreadState],
      [{ connectionId: 'connection-1', identityId: 'reader-1' }]
    );
  });
});

describe('DropCreationApiService.deleteMyWaveChatHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes the authenticated author chat drops and preserves their pinned drop', async () => {
    const connection = {} as any;
    const chatDrops = [
      { id: 'chat-1' },
      { id: 'pinned-chat' },
      { id: 'chat-2' }
    ];
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback(connection)
      ),
      findWaveChatDropsByAuthorForUpdate: jest.fn().mockResolvedValue(chatDrops)
    };
    const deleteDrop = {
      execute: jest.fn().mockImplementation(async ({ drop_id }) => ({
        id: drop_id,
        serial_no: drop_id === 'chat-1' ? 10 : 12,
        visibility_group_id: 'group-1',
        wave_id: 'wave-1',
        dm_unread_recipient_ids: []
      }))
    };
    const wsListenersNotifier = {
      notifyAboutDropDeletes: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue({
        id: 'wave-1',
        description_drop_id: 'pinned-chat'
      })
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
      {} as never,
      wavesApiDb as never
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

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).resolves.toEqual({
      deleted_drop_ids: ['chat-1', 'chat-2'],
      preserved_pinned_drop_id: 'pinned-chat'
    });

    expect(wavesApiDb.findWaveByIdForUpdate).toHaveBeenCalledWith(
      'wave-1',
      expect.objectContaining({
        authenticationContext: ctx.authenticationContext,
        connection,
        timer: ctx.timer
      })
    );
    expect(dropsDb.findWaveChatDropsByAuthorForUpdate).toHaveBeenCalledWith(
      { waveId: 'wave-1', authorId: 'profile-1' },
      expect.objectContaining({ connection })
    );
    expect(deleteDrop.execute).toHaveBeenCalledTimes(2);
    expect(deleteDrop.execute).toHaveBeenNthCalledWith(
      1,
      {
        drop_id: 'chat-1',
        deleter_identity: 'profile-1',
        deleter_id: 'profile-1',
        deletion_purpose: 'DELETE'
      },
      { timer: ctx.timer, connection }
    );
    expect(deleteDrop.execute).toHaveBeenNthCalledWith(
      2,
      {
        drop_id: 'chat-2',
        deleter_identity: 'profile-1',
        deleter_id: 'profile-1',
        deletion_purpose: 'DELETE'
      },
      { timer: ctx.timer, connection }
    );
    expect(requestWaveDropMetricsRefreshSpy).toHaveBeenCalledTimes(1);
    expect(requestWaveScoreRefreshSpy).toHaveBeenCalledTimes(1);
    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledWith('wave-1');
    expect(wsListenersNotifier.notifyAboutDropDeletes).toHaveBeenCalledWith(
      [
        { drop_id: 'chat-1', drop_serial: 10, wave_id: 'wave-1' },
        { drop_id: 'chat-2', drop_serial: 12, wave_id: 'wave-1' }
      ],
      'group-1',
      {
        authenticationContext: ctx.authenticationContext,
        timer: ctx.timer
      }
    );
  });

  it('does not delete or publish when the only authored chat drop is pinned', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      findWaveChatDropsByAuthorForUpdate: jest
        .fn()
        .mockResolvedValue([{ id: 'pinned-chat' }])
    };
    const deleteDrop = { execute: jest.fn() };
    const wsListenersNotifier = { notifyAboutDropDeletes: jest.fn() };
    const wavesApiDb = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue({
        id: 'wave-1',
        description_drop_id: 'pinned-chat'
      })
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
      {} as never,
      wavesApiDb as never
    );
    const requestWaveDropMetricsRefreshSpy = jest.spyOn(
      waveDropMetricsRefreshService,
      'requestWaveDropMetricsRefreshBestEffort'
    );
    const requestWaveScoreRefreshSpy = jest.spyOn(
      waveScoreService,
      'requestWaveScoreRefreshBestEffort'
    );
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).resolves.toEqual({
      deleted_drop_ids: [],
      preserved_pinned_drop_id: 'pinned-chat'
    });

    expect(deleteDrop.execute).not.toHaveBeenCalled();
    expect(requestWaveDropMetricsRefreshSpy).not.toHaveBeenCalled();
    expect(requestWaveScoreRefreshSpy).not.toHaveBeenCalled();
    expect(invalidateWaveUnreadCacheForWave).not.toHaveBeenCalled();
    expect(wsListenersNotifier.notifyAboutDropDeletes).not.toHaveBeenCalled();
  });

  it('attempts every post-commit effect when one effect fails', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      findWaveChatDropsByAuthorForUpdate: jest
        .fn()
        .mockResolvedValue([{ id: 'chat-1' }])
    };
    const deleteDrop = {
      execute: jest.fn().mockResolvedValue({
        id: 'chat-1',
        serial_no: 10,
        visibility_group_id: 'group-1',
        wave_id: 'wave-1',
        dm_unread_recipient_ids: []
      })
    };
    const wsListenersNotifier = {
      notifyAboutDropDeletes: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue({
        id: 'wave-1',
        description_drop_id: 'different-author-pinned-drop'
      })
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
      {} as never,
      wavesApiDb as never
    );
    const requestWaveDropMetricsRefreshSpy = jest
      .spyOn(
        waveDropMetricsRefreshService,
        'requestWaveDropMetricsRefreshBestEffort'
      )
      .mockRejectedValue(new Error('metrics unavailable'));
    const requestWaveScoreRefreshSpy = jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
    jest
      .mocked(invalidateWaveUnreadCacheForWave)
      .mockRejectedValueOnce(new Error('cache unavailable'));
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).resolves.toEqual({
      deleted_drop_ids: ['chat-1'],
      preserved_pinned_drop_id: null
    });

    expect(requestWaveDropMetricsRefreshSpy).toHaveBeenCalledTimes(1);
    expect(requestWaveScoreRefreshSpy).toHaveBeenCalledTimes(1);
    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledWith('wave-1');
    expect(wsListenersNotifier.notifyAboutDropDeletes).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing wave before selecting or deleting drops', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      findWaveChatDropsByAuthorForUpdate: jest.fn()
    };
    const deleteDrop = { execute: jest.fn() };
    const wavesApiDb = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue(null)
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      {} as never,
      {} as never,
      deleteDrop as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      wavesApiDb as never
    );
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'missing-wave' }, ctx as never)
    ).rejects.toThrow('Wave missing-wave not found');

    expect(dropsDb.findWaveChatDropsByAuthorForUpdate).not.toHaveBeenCalled();
    expect(deleteDrop.execute).not.toHaveBeenCalled();
  });

  it('does not publish post-commit effects when a transactional delete fails', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (callback: (connection: unknown) => Promise<unknown>) =>
          callback({})
      ),
      findWaveChatDropsByAuthorForUpdate: jest
        .fn()
        .mockResolvedValue([{ id: 'chat-1' }, { id: 'chat-2' }])
    };
    const deleteDrop = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'chat-1',
          serial_no: 10,
          visibility_group_id: 'group-1',
          wave_id: 'wave-1',
          dm_unread_recipient_ids: []
        })
        .mockRejectedValueOnce(new Error('delete failed'))
    };
    const wsListenersNotifier = { notifyAboutDropDeletes: jest.fn() };
    const wavesApiDb = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue({
        id: 'wave-1',
        description_drop_id: 'different-author-pinned-drop'
      })
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
      {} as never,
      wavesApiDb as never
    );
    const requestWaveDropMetricsRefreshSpy = jest.spyOn(
      waveDropMetricsRefreshService,
      'requestWaveDropMetricsRefreshBestEffort'
    );
    const requestWaveScoreRefreshSpy = jest.spyOn(
      waveScoreService,
      'requestWaveScoreRefreshBestEffort'
    );
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).rejects.toThrow('delete failed');

    expect(deleteDrop.execute).toHaveBeenCalledTimes(2);
    expect(requestWaveDropMetricsRefreshSpy).not.toHaveBeenCalled();
    expect(requestWaveScoreRefreshSpy).not.toHaveBeenCalled();
    expect(invalidateWaveUnreadCacheForWave).not.toHaveBeenCalled();
    expect(wsListenersNotifier.notifyAboutDropDeletes).not.toHaveBeenCalled();
  });

  it('rejects a missing acting profile before opening a transaction', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn()
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue(null),
        isAuthenticatedAsProxy: jest.fn()
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).rejects.toThrow('Please create a profile first');

    expect(dropsDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('rejects proxy deletion before opening a transaction', async () => {
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn()
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('profile-1'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(true)
      },
      timer: undefined
    };

    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave-1' }, ctx as never)
    ).rejects.toThrow('Proxy is not allowed to delete chat history');

    expect(dropsDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });
});
