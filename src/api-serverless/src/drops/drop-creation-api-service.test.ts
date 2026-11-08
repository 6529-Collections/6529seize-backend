import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
jest.mock('@/competitions/competition-entry-drop-hooks');
import { waveScoreService } from '@/api/waves/wave-score.service';
import { invalidateWaveUnreadCacheForWave } from '@/api/waves/wave-unread-cache';
import { DropType } from '@/entities/IDrop';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { DbPoolName } from '@/db-query.options';
import { dropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { dropsMappers } from '@/api/drops/drops.mappers';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { moderationFingerprint } from '@/content-moderation/moderation-review.types';
import { sanitizeDropStructuredFields } from '@/drops/create-or-update-drop.use-case';
import { helpBotDailyActivityCreditQueueService } from '@/help-bot/help-bot-daily-activity-credit-queue.service';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  // After-commit bumps from the DB chokepoints (drop insert/delete, reader
  // metrics, wave insert, blocks and mutes).
  invalidateWaveUnreadCacheForWaveAfterCommit: jest
    .fn()
    .mockResolvedValue(undefined),
  invalidateWaveUnreadCacheForWavesAfterCommit: jest
    .fn()
    .mockResolvedValue(undefined),
  invalidateWaveUnreadCacheForReaderWaveAfterCommit: jest
    .fn()
    .mockResolvedValue(undefined),
  invalidateWaveUnreadCacheForReaderAfterCommit: jest
    .fn()
    .mockResolvedValue(undefined),
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
    executeNativeQueriesInTransaction: jest.fn(async (callback) =>
      callback({})
    ),
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
      expect.objectContaining({ ...ctx, connection: expect.any(Object) })
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
      expect.objectContaining({ ...ctx, connection: expect.any(Object) })
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
      expect.objectContaining({ ...ctx, connection: expect.any(Object) })
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
      expect.objectContaining({ ...ctx, connection: expect.any(Object) })
    );
    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
  });
});

describe('DropCreationApiService.updateDrop', () => {
  it('rejects a non-author before preparing or moderating the update', async () => {
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue({
        id: 'drop-1',
        author_id: 'original-author'
      })
    };
    const dropsMappers = {
      updateDropApiToUseCaseModel: jest.fn()
    };
    const createOrUpdateDrop = {
      preResolveIdentityNomination: jest.fn(),
      preparePrePublication: jest.fn()
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      dropsMappers as never,
      createOrUpdateDrop as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.updateDrop(
        {
          dropId: 'drop-1',
          request: {} as never,
          authorId: 'different-author',
          representativeId: 'different-author'
        },
        {} as never
      )
    ).rejects.toThrow('Only the author can update drop drop-1');

    expect(dropsMappers.updateDropApiToUseCaseModel).not.toHaveBeenCalled();
    expect(createOrUpdateDrop.preparePrePublication).not.toHaveBeenCalled();
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
        preparePrePublication: jest.fn().mockResolvedValue({
          dropId: 'drop-1',
          operation: 'CREATE'
        }),
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
        // The created drop is read back after commit, in its own transaction.
        'transaction',
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
      preparePrePublication: jest.fn().mockResolvedValue({
        dropId: 'drop-1',
        operation: 'CREATE'
      }),
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
      // The created drop is read back after commit, in its own transaction.
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
      preparePrePublication: jest.fn().mockResolvedValue({
        dropId: 'drop-1',
        operation: 'CREATE'
      }),
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

describe('DropCreationApiService bounded chat history purge', () => {
  function setup() {
    process.env.JWT_SECRET = 'purge-unit-test-secret';
    const connection = {};
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (callback) =>
        callback(connection)
      ),
      findDropById: jest.fn().mockResolvedValue({
        id: 'pin',
        author_id: 'author',
        drop_type: DropType.CHAT
      })
    };
    const purgeDb = {
      findCutoff: jest.fn().mockResolvedValue(60000),
      findBatchForUpdate: jest
        .fn()
        .mockResolvedValue([{ id: 'chat', serial_no: 1 }])
    };
    const deletion = {
      executeChatHistoryBatch: jest.fn().mockResolvedValue([]),
      execute: jest.fn()
    };
    const notifier = {
      notifyAboutDropDeletes: jest.fn().mockResolvedValue(undefined)
    };
    const waves = {
      findWaveByIdForUpdate: jest.fn().mockResolvedValue({
        id: 'wave',
        description_drop_id: 'pin',
        visibility_group_id: null
      })
    };
    const ctx = {
      authenticationContext: {
        getActingAsId: jest.fn().mockReturnValue('author'),
        isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
      }
    };
    const service = new DropCreationApiService(
      {} as never,
      dropsDb as never,
      {} as never,
      {} as never,
      deletion as never,
      notifier as never,
      {} as never,
      {} as never,
      {} as never,
      waves as never,
      {} as never,
      purgeDb as never
    );
    jest
      .spyOn(
        waveDropMetricsRefreshService,
        'requestWaveDropMetricsRefreshBestEffort'
      )
      .mockResolvedValue(undefined);
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
    return { service, ctx, dropsDb, purgeDb, deletion, notifier, waves };
  }
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('prepares without deletion and retains the frozen cutoff after a lost response', async () => {
    const { service, ctx, purgeDb, deletion } = setup();
    const { purge_token } = await service.prepareMyWaveChatHistoryPurge(
      { waveId: 'wave' },
      ctx as never
    );
    expect(deletion.executeChatHistoryBatch).not.toHaveBeenCalled();
    purgeDb.findCutoff.mockResolvedValue(70000);
    purgeDb.findBatchForUpdate.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: `chat-${i}`,
        serial_no: i + 1
      }))
    );
    const request = { waveId: 'wave', purgeToken: purge_token };
    const first = await service.deleteMyWaveChatHistory(request, ctx as never);
    expect(first.has_more).toBe(true);
    expect(first.deleted_drop_ids).toHaveLength(100);
    await service.deleteMyWaveChatHistory(request, ctx as never);
    expect(purgeDb.findCutoff).toHaveBeenCalledTimes(1);
    expect(purgeDb.findBatchForUpdate).toHaveBeenLastCalledWith(
      {
        waveId: 'wave',
        authorId: 'author',
        cutoffSerialNo: 60000,
        pinnedDropId: 'pin'
      },
      expect.anything()
    );
    expect(deletion.execute).not.toHaveBeenCalled();
    expect(deletion.executeChatHistoryBatch).toHaveBeenCalledTimes(2);
  });

  it('refuses an oversized legacy purge before mutation', async () => {
    const { service, ctx, purgeDb, deletion, notifier } = setup();
    purgeDb.findBatchForUpdate.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: `chat-${i}`,
        serial_no: i + 1
      }))
    );
    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave' }, ctx as never)
    ).rejects.toThrow('update your app');
    expect(deletion.executeChatHistoryBatch).not.toHaveBeenCalled();
    expect(notifier.notifyAboutDropDeletes).not.toHaveBeenCalled();
  });

  it('completes a small legacy purge and runs post-commit work once', async () => {
    const { service, ctx, deletion, notifier } = setup();
    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave' }, ctx as never)
    ).resolves.toEqual({
      deleted_drop_ids: ['chat'],
      preserved_pinned_drop_id: 'pin',
      has_more: false
    });
    expect(deletion.executeChatHistoryBatch).toHaveBeenCalledTimes(1);
    expect(notifier.notifyAboutDropDeletes).toHaveBeenCalledTimes(1);
    expect(
      waveScoreService.requestWaveScoreRefreshBestEffort
    ).toHaveBeenCalledTimes(1);
    expect(
      waveDropMetricsRefreshService.requestWaveDropMetricsRefreshBestEffort
    ).toHaveBeenCalledTimes(1);
    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledTimes(1);
  });

  it('uses the latest pin and returns an empty final batch without post-commit work', async () => {
    const { service, ctx, purgeDb, waves, notifier, dropsDb } = setup();
    const plan = await service.prepareMyWaveChatHistoryPurge(
      { waveId: 'wave' },
      ctx as never
    );
    waves.findWaveByIdForUpdate.mockResolvedValue({
      id: 'wave',
      description_drop_id: 'new-pin',
      visibility_group_id: null
    });
    dropsDb.findDropById.mockResolvedValue({
      id: 'new-pin',
      author_id: 'other',
      drop_type: DropType.CHAT
    });
    purgeDb.findBatchForUpdate.mockResolvedValue([]);
    await expect(
      service.deleteMyWaveChatHistory(
        { waveId: 'wave', purgeToken: plan.purge_token },
        ctx as never
      )
    ).resolves.toEqual({
      deleted_drop_ids: [],
      preserved_pinned_drop_id: null,
      has_more: false
    });
    expect(purgeDb.findBatchForUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedDropId: 'new-pin' }),
      expect.anything()
    );
    expect(notifier.notifyAboutDropDeletes).not.toHaveBeenCalled();
  });

  it('reports committed deletion even if a post-commit effect fails', async () => {
    const { service, ctx, notifier } = setup();
    notifier.notifyAboutDropDeletes.mockRejectedValue(new Error('offline'));
    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave' }, ctx as never)
    ).resolves.toMatchObject({ deleted_drop_ids: ['chat'], has_more: false });
    expect(invalidateWaveUnreadCacheForWave).toHaveBeenCalledTimes(1);
  });

  it('does not notify when batch transaction fails', async () => {
    const { service, ctx, deletion, notifier } = setup();
    deletion.executeChatHistoryBatch.mockRejectedValue(new Error('rollback'));
    await expect(
      service.deleteMyWaveChatHistory({ waveId: 'wave' }, ctx as never)
    ).rejects.toThrow('rollback');
    expect(notifier.notifyAboutDropDeletes).not.toHaveBeenCalled();
    expect(invalidateWaveUnreadCacheForWave).not.toHaveBeenCalled();
  });

  it.each(['missing-profile', 'proxy', 'missing-wave', 'bad-token'])(
    'rejects %s safely',
    async (failure) => {
      const { service, ctx, waves, deletion } = setup();
      if (failure === 'missing-profile')
        ctx.authenticationContext.getActingAsId.mockReturnValue(null);
      if (failure === 'proxy')
        ctx.authenticationContext.isAuthenticatedAsProxy.mockReturnValue(true);
      if (failure === 'missing-wave')
        waves.findWaveByIdForUpdate.mockResolvedValue(null);
      await expect(
        service.deleteMyWaveChatHistory(
          {
            waveId: 'wave',
            ...(failure === 'bad-token' ? { purgeToken: 'bad' } : {})
          },
          ctx as never
        )
      ).rejects.toThrow();
      if (failure !== 'bad-token')
        await expect(
          service.prepareMyWaveChatHistoryPurge(
            { waveId: 'wave' },
            ctx as never
          )
        ).rejects.toThrow();
      expect(deletion.executeChatHistoryBatch).not.toHaveBeenCalled();
    }
  );
});

describe('DropCreationApiService.createDrop delivery hops (1.0)', () => {
  const originalLambda = process.env.AWS_LAMBDA_FUNCTION_NAME;

  beforeEach(() => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'api';
    (sendIdentityPushNotifications as jest.Mock).mockResolvedValue(undefined);
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'enqueueRequest')
      .mockResolvedValue(false);
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalLambda === undefined)
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = originalLambda;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('emits one record with the commit and every post-commit hop', async () => {
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const service = new DropCreationApiService(
      {
        findDropByIdOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'drop-1', wave_id: 'wave-1' })
      } as never,
      {
        executeNativeQueriesInTransaction: jest.fn(async (callback) =>
          callback({})
        )
      } as never,
      {
        createDropApiToUseCaseModel: jest
          .fn()
          .mockReturnValue({ wave_id: 'wave-1', drop_type: DropType.CHAT })
      } as never,
      {
        preResolveIdentityNomination: jest.fn().mockResolvedValue(null),
        preparePrePublication: jest.fn().mockResolvedValue({}),
        execute: jest.fn().mockResolvedValue({
          drop_id: 'drop-1',
          pending_push_notification_ids: []
        })
      } as never,
      {} as never,
      {
        notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined),
        notifyAboutIdentityNotificationsChanged: jest
          .fn()
          .mockResolvedValue(undefined)
      } as never,
      { findByDropId: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { createPollForDrop: jest.fn().mockResolvedValue(undefined) } as never
    );

    await service.createDrop(
      {
        createDropRequest: { collaborator_ids: ['collaborator-1'] } as never,
        authorId: 'author-profile',
        representativeId: 'author-profile'
      },
      {
        timer: {
          start: jest.fn(),
          stop: jest.fn(),
          getTotalTimePassed: () => ({ toMillis: () => 12 })
        }
      } as never
    );

    const records = stdout.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((record) => record.event === 'WAVE_DROP_POST');
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      FrameType: 'DROP_POST',
      drop_id: 'drop-1',
      wave_id: 'wave-1'
    });
    for (const hop of [
      'drop_pre_commit_ms',
      'drop_commit_ms',
      'post_commit_wave_score_ms',
      'post_commit_unread_cache_ms',
      'post_commit_push_ms',
      'post_commit_fanout_ms',
      'post_commit_collaborators_ms',
      'post_commit_dm_unread_ms',
      'drop_post_commit_ms'
    ]) {
      expect(typeof record[hop]).toBe('number');
    }
    expect(record.drop_post_total_ms).toBeGreaterThanOrEqual(12);
    expect(record).not.toHaveProperty('post_commit_daily_activity_ms');
  });
});

describe('DropCreationApiService.createDrop media upload ids (R11-2)', () => {
  beforeEach(() => {
    (sendIdentityPushNotifications as jest.Mock).mockResolvedValue(undefined);
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'enqueueRequest')
      .mockResolvedValue(false);
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('writes the media with the author’s own upload id, which links its layout hints', async () => {
    const url = 'https://media.example/drops/u/photo.jpg';
    jest.spyOn(dropMediaUploadsDb, 'findById').mockResolvedValue({
      id: 'upload-1',
      profile_id: 'author-profile',
      public_url: url,
      declared_mime_type: 'image/jpeg',
      status: DropMediaUploadStatus.READY,
      drop_id: null,
      wave_id: null
    } as never);
    const execute = jest.fn().mockResolvedValue({
      drop_id: 'drop-1',
      pending_push_notification_ids: []
    });
    const service = new DropCreationApiService(
      {
        findDropByIdOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'drop-1', wave_id: 'wave-1' })
      } as never,
      {
        executeNativeQueriesInTransaction: jest.fn(async (callback) =>
          callback({})
        )
      } as never,
      dropsMappers,
      {
        preResolveIdentityNomination: jest.fn().mockResolvedValue(null),
        preparePrePublication: jest.fn().mockResolvedValue({}),
        execute
      } as never,
      {} as never,
      {
        notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
      } as never,
      { findByDropId: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { createPollForDrop: jest.fn().mockResolvedValue(undefined) } as never
    );

    await service.createDrop(
      {
        createDropRequest: {
          wave_id: 'wave-1',
          drop_type: 'CHAT',
          title: null,
          parts: [
            {
              content: 'photo',
              quoted_drop: null,
              media: [
                { url, mime_type: 'image/jpeg', media_upload_id: 'upload-1' }
              ]
            }
          ],
          referenced_nfts: [],
          mentioned_users: [],
          metadata: []
        } as never,
        authorId: 'author-profile',
        representativeId: 'author-profile'
      },
      { timer: undefined } as never
    );

    // Before R11-2 the API mapping dropped the id, so chat media never
    // linked to its upload's hints.
    expect(execute.mock.calls[0][0].parts[0].media).toEqual([
      { url, mime_type: 'image/jpeg', media_upload_id: 'upload-1' }
    ]);
  });
});

describe('DropCreationApiService.createDrop media upload ids on a replay (R11-2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('returns the published drop when a retry resolves its ids as the first attempt did', async () => {
    const url = 'https://media.example/drops/u/photo.jpg';
    const request = {
      wave_id: 'wave-1',
      drop_type: 'CHAT',
      title: null,
      parts: [
        {
          content: 'photo',
          quoted_drop: null,
          media: [{ url, mime_type: 'image/jpeg', media_upload_id: 'upload-1' }]
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      metadata: []
    };
    // What the first attempt published: the model with the upload id kept.
    const publishedModel = dropsMappers.createDropApiToUseCaseModel({
      request: request as never,
      authorId: 'author-profile'
    });
    publishedModel.parts[0].media[0] = {
      ...publishedModel.parts[0].media[0],
      media_upload_id: 'upload-1'
    };
    jest.spyOn(moderationReviewDb, 'savedRequest').mockResolvedValue({
      published_subject_id: 'drop-1',
      scope: {
        context_fingerprint: moderationFingerprint(
          sanitizeDropStructuredFields(publishedModel)
        )
      }
    } as never);
    // Since then the upload was attached to that drop, and its status moved.
    jest.spyOn(dropMediaUploadsDb, 'findById').mockResolvedValue({
      id: 'upload-1',
      profile_id: 'author-profile',
      public_url: url,
      declared_mime_type: 'image/jpeg',
      status: DropMediaUploadStatus.FAILED,
      drop_id: 'drop-1',
      wave_id: 'wave-1'
    } as never);
    const findDropByIdOrThrow = jest
      .fn()
      .mockResolvedValue({ id: 'drop-1', wave_id: 'wave-1' });
    const execute = jest.fn();
    const service = new DropCreationApiService(
      { findDropByIdOrThrow } as never,
      { executeNativeQueriesInTransaction: jest.fn() } as never,
      dropsMappers,
      {
        preResolveIdentityNomination: jest.fn(),
        preparePrePublication: jest.fn(),
        execute
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.createDrop(
        {
          createDropRequest: request as never,
          authorId: 'author-profile',
          representativeId: 'author-profile'
        },
        { timer: undefined, moderationRequestId: 'request-1' } as never
      )
    ).resolves.toEqual({ id: 'drop-1', wave_id: 'wave-1' });
    expect(findDropByIdOrThrow).toHaveBeenCalledWith(
      { dropId: 'drop-1' },
      expect.anything()
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
