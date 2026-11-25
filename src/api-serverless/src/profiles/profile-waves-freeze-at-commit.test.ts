import { AuthenticationContext } from '@/auth-context';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { ProfileWavesApiService } from './profile-waves.api.service';

describe('a profile wave change admitted before the identity freeze that commits after it', () => {
  const service = new ProfileWavesApiService();
  const ctx = {
    authenticationContext: AuthenticationContext.fromProfileId('profile-1')
  };
  let clock: ReturnType<typeof freezeClock>;
  let tx: ReturnType<typeof fakeTransactionalDb>;

  /** `onWrite` runs at the profile wave row's write. */
  function stub(onWrite: () => void) {
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(tx.executeNativeQueriesInTransaction as any);
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      created_by: 'profile-1',
      is_direct_message: false,
      visibility_group_id: null
    } as any);
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ id: 'profile-1' } as any);
    const set = jest
      .spyOn(profileWavesDb, 'setProfileWave')
      .mockImplementation(async () => onWrite());
    const clear = jest
      .spyOn(profileWavesDb, 'deleteByProfileId')
      .mockImplementation(async () => onWrite());
    return { set, clear };
  }

  const steps = {
    set: () => service.setProfileWave('alice', { wave_id: 'wave-1' }, ctx),
    clear: () => service.clearProfileWave('alice', ctx)
  };

  beforeEach(() => {
    clock = freezeClock();
    tx = fakeTransactionalDb();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it.each(['set', 'clear'] as const)(
    '%s refuses at COMMIT and rolls back',
    async (step) => {
      const writes = stub(() => clock.pass());
      await expectRefusedAtCommit(steps[step](), tx.statements);
      expect(writes[step]).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          connection: expect.objectContaining({ connection: tx.connection })
        })
      );
    }
  );

  it.each(['set', 'clear'] as const)(
    '%s commits when it ends before T',
    async (step) => {
      stub(() => undefined);
      await expect(steps[step]()).resolves.toEqual({ id: 'profile-1' });
      expectCommitted(tx.statements);
    }
  );
});
