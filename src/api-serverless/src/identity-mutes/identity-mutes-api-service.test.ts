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
    notifyAboutDmUnreadStateChanged: jest.fn().mockResolvedValue(undefined)
  };
  const service = new IdentityMutesApiService(
    identityMutesDb as never,
    identityFetcher as never,
    wavesApiDb as never,
    wsListenersNotifier as never
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
        { readerId: 'muter-1', authorId: 'muted-1', limit: 500 },
        ctx
      );
      expect(
        wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
      ).toHaveBeenCalledWith({ readerId: 'muter-1', waveIds: ['wave-1'] }, ctx);
      expect(wavesApiDb.findDmUnreadConversationStates).toHaveBeenCalledWith(
        { identityId: 'muter-1', waveIds: ['wave-1'] },
        ctx,
        DbPoolName.WRITE
      );
      expect(
        wsListenersNotifier.notifyAboutDmUnreadStateChanged
      ).toHaveBeenCalledWith([dmUnreadState]);
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
        limit: 500,
        afterWaveId: 'wave-499'
      },
      ctx
    );
    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForReaderWaves
    ).toHaveBeenCalledTimes(2);
    expect(
      wsListenersNotifier.notifyAboutDmUnreadStateChanged
    ).toHaveBeenCalledTimes(2);
  });
});
