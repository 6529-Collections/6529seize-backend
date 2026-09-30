import { IdentityMutesDb } from './identity-mutes.db';
import { SqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { IdentityMutesApiService } from './identity-mutes.api.service';

const dmUnreadState = {
  profile_id: 'muter-1',
  wave_id: 'wave-1',
  unread_count: 0,
  first_unread_drop_serial_no: null,
  latest_drop_serial_no: 10,
  latest_read_serial_no: 9,
  version: 4
};

function createService() {
  const identityMutesDb = {
    muteIdentity: jest.fn().mockResolvedValue(undefined),
    unmuteIdentity: jest.fn().mockResolvedValue(undefined)
  };
  const identityFetcher = {
    getProfileIdByIdentityKeyOrThrow: jest.fn().mockResolvedValue('muted-1')
  };
  const wavesApiDb = {
    findDmWaveIdsForReaderWithDropsByAuthor: jest
      .fn()
      .mockResolvedValue(['wave-1']),
    incrementDmUnreadStateVersionsForReaderWaves: jest
      .fn()
      .mockResolvedValue(undefined),
    findDmUnreadConversationStates: jest.fn().mockResolvedValue([dmUnreadState])
  };
  const wsListenersNotifier = {
    findConnectedNotificationRecipients: jest
      .fn()
      .mockResolvedValue([
        { connectionId: 'connection-1', identityId: 'muter-1' }
      ]),
    notifyAboutDmUnreadStateChanged: jest.fn().mockResolvedValue(undefined)
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest
      .fn()
      .mockResolvedValue(['visible-dm-group'])
  };
  const service = new IdentityMutesApiService(
    identityMutesDb as never,
    identityFetcher as never,
    wavesApiDb as never,
    wsListenersNotifier as never,
    userGroupsService as never
  );
  const ctx = {
    authenticationContext: {
      getActingAsId: jest.fn().mockReturnValue('muter-1')
    }
  };
  return {
    ctx,
    identityMutesDb,
    service,
    userGroupsService,
    wavesApiDb,
    wsListenersNotifier
  };
}

describe('IdentityMutesApiService DM unread synchronization', () => {
  it.each([
    ['muteIdentity', 'muteIdentity', true],
    ['unmuteIdentity', 'unmuteIdentity', false]
  ] as const)(
    'updates and broadcasts affected states after %s',
    async (serviceMethod, dbMethod, muted) => {
      const { ctx, identityMutesDb, service, wavesApiDb, wsListenersNotifier } =
        createService();

      await expect(
        service[serviceMethod]('muted-handle', ctx as never)
      ).resolves.toEqual({ muted });

      expect(identityMutesDb[dbMethod]).toHaveBeenCalledWith(
        { muter_id: 'muter-1', muted_identity_id: 'muted-1' },
        ctx
      );
      expect(
        wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor
      ).toHaveBeenCalledWith(
        {
          readerId: 'muter-1',
          authorId: 'muted-1',
          eligibleGroups: ['visible-dm-group'],
          limit: 500
        },
        ctx
      );
      expect(
        wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
      ).not.toHaveBeenCalled();
      expect(wavesApiDb.findDmUnreadConversationStates).toHaveBeenCalledWith(
        {
          identityId: 'muter-1',
          eligibleGroups: ['visible-dm-group'],
          waveIds: ['wave-1']
        },
        ctx,
        DbPoolName.WRITE
      );
      expect(
        wsListenersNotifier.notifyAboutDmUnreadStateChanged
      ).toHaveBeenCalledWith(
        [dmUnreadState],
        [{ connectionId: 'connection-1', identityId: 'muter-1' }]
      );
    }
  );

  it('continues synchronizing after the first 500 affected conversations', async () => {
    const { ctx, service, wavesApiDb, wsListenersNotifier } = createService();
    const firstPage = Array.from(
      { length: 500 },
      (_, index) => `wave-${String(index).padStart(3, '0')}`
    );
    wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(['wave-500']);

    await service.muteIdentity('muted-handle', ctx as never);

    expect(
      wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor
    ).toHaveBeenNthCalledWith(
      2,
      {
        readerId: 'muter-1',
        authorId: 'muted-1',
        eligibleGroups: ['visible-dm-group'],
        limit: 500,
        afterWaveId: 'wave-499'
      },
      ctx
    );
    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
    ).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledTimes(2);
  });

  it('leaves transactional versioning to the mutation repository when the reader is offline', async () => {
    const { ctx, service, wavesApiDb, wsListenersNotifier } = createService();
    wsListenersNotifier.findConnectedNotificationRecipients.mockResolvedValue(
      []
    );

    await service.muteIdentity('muted-handle', ctx as never);

    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
    ).not.toHaveBeenCalled();
    expect(wavesApiDb.findDmUnreadConversationStates).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).not.toHaveBeenCalled();
  });

  it('does not version or broadcast inaccessible conversations', async () => {
    const { ctx, service, userGroupsService, wavesApiDb, wsListenersNotifier } =
      createService();
    userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor.mockResolvedValue([]);

    await service.muteIdentity('muted-handle', ctx as never);

    expect(
      wavesApiDb.findDmWaveIdsForReaderWithDropsByAuthor
    ).toHaveBeenCalledWith(
      {
        readerId: 'muter-1',
        authorId: 'muted-1',
        eligibleGroups: [],
        limit: 500
      },
      ctx
    );
    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
    ).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).not.toHaveBeenCalled();
  });
});

it.each(['muteIdentity', 'unmuteIdentity'] as const)(
  '%s versions all affected offline reader waves through the real mutation repository',
  async (method) => {
    const { service, identityMutesDb, wsListenersNotifier, wavesApiDb, ctx } =
      createService();
    const connection = { connection: {} };
    const execute = jest.fn(async (sql: string) =>
      sql.includes('select r.wave_id')
        ? [{ wave_id: 'wave-1' }, { wave_id: 'wave-2' }]
        : []
    );
    const repository = new IdentityMutesDb(
      () => ({ execute }) as unknown as SqlExecutor
    );
    identityMutesDb[method].mockImplementation((pair, context) =>
      repository[method](pair, context)
    );
    wsListenersNotifier.findConnectedNotificationRecipients.mockResolvedValue(
      []
    );
    await service[method]('muted-handle', { ...ctx, connection } as never);
    const increments = execute.mock.calls.filter(([sql]) =>
      sql.includes('set unread_state_version = unread_state_version + 1')
    );
    expect(increments).toHaveLength(2);
    for (const waveId of ['wave-1', 'wave-2']) {
      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining(
          'set unread_state_version = unread_state_version + 1'
        ),
        { readerId: 'muter-1', waveId },
        { wrappedConnection: connection }
      );
    }
    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
    ).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).not.toHaveBeenCalled();
  }
);
