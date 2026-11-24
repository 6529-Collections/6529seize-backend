import { identityFetcher } from '@/api/identities/identity.fetcher';
import { AuthenticationContext } from '@/auth-context';
import { ProfileClassification } from '@/entities/IProfile';
import { identitiesDb } from '@/identities/identities.db';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { RatingsService } from '@/rates/ratings.service';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { profilesDb } from './profiles.db';
import { profilesService } from './profiles.service';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

function identityOf(wallet: string, withProfile: boolean) {
  return {
    identity: {
      profile_id: `profile-${wallet}`,
      primary_address: wallet,
      consolidation_key: wallet,
      pfp: null
    },
    profile: withProfile
      ? {
          external_id: `profile-${wallet}`,
          handle: 'someone',
          normalised_handle: 'someone',
          pfp_url: null,
          classification: ProfileClassification.PSEUDONYM
        }
      : null,
    consolidations: []
  };
}

/**
 * Stubs the reads and writes of a profile create or update. `onWrite` runs
 * at the profile row's write, where a lock would be waited on.
 */
function stubProfileWrites(withProfile: boolean, onWrite: () => void) {
  jest
    .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
    .mockImplementation(
      async (wallets: string[]) =>
        Object.fromEntries(
          wallets.map((wallet) => [wallet, identityOf(wallet, withProfile)])
        ) as any
    );
  jest.spyOn(identitiesDb, 'getIdentityByHandle').mockResolvedValue(null);
  jest
    .spyOn(identitiesDb, 'updateIdentityProfile')
    .mockResolvedValue(undefined as any);
  const insert = jest
    .spyOn(profilesDb, 'insertProfileRecord')
    .mockImplementation(async () => onWrite());
  const update = jest
    .spyOn(profilesDb, 'updateProfileRecord')
    .mockImplementation(async () => onWrite());
  jest
    .spyOn(profileActivityLogsDb, 'insertMany')
    .mockResolvedValue(undefined as any);
  jest
    .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
    .mockResolvedValue({ id: 'profile' } as any);
  return { insert, update };
}

function profileCommand(wallet = WALLET) {
  return {
    handle: 'someone',
    creator_or_updater_wallet: wallet,
    classification: ProfileClassification.PSEUDONYM,
    sub_classification: null,
    pfp_url: null
  };
}

describe('a profile write admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  let tx: ReturnType<typeof fakeTransactionalDb>;
  beforeEach(() => {
    clock = freezeClock();
    tx = fakeTransactionalDb();
    jest
      .spyOn(profilesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(tx.executeNativeQueriesInTransaction as any);
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it.each([
    ['an update of an existing profile', true],
    ['a new profile', false]
  ])(
    'createOrUpdateProfile refuses %s at COMMIT and rolls it back',
    async (_, withProfile) => {
      const { insert, update } = stubProfileWrites(withProfile, () =>
        clock.pass()
      );
      await expectRefusedAtCommit(
        profilesService.createOrUpdateProfile(profileCommand()),
        tx.statements
      );
      const write = withProfile ? update : insert;
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0].at(-1)).toEqual(
        expect.objectContaining({ connection: tx.connection })
      );
    }
  );

  it('createOrUpdateProfile commits a write that ends before T', async () => {
    stubProfileWrites(true, () => undefined);
    await profilesService.createOrUpdateProfile(profileCommand());
    expectCommitted(tx.statements);
  });
});

describe('profiles made inside a rating transaction', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  /**
   * A bulk REP rating of wallets that have identities but no profiles: the
   * rating's transaction makes their profiles through
   * createOrUpdateProfileWithGivenTransaction, on its own connection.
   */
  function ratingTransaction(wallets: string[], onRate: () => void) {
    const tx = fakeTransactionalDb();
    let profilesMade = false;
    const ratingsIdentitiesDb = {
      executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
      getEverythingRelatedToIdentitiesByAddresses: jest.fn(async () =>
        Object.fromEntries(
          wallets.map((wallet) => [wallet, identityOf(wallet, profilesMade)])
        )
      ),
      insertIdentity: jest.fn()
    };
    const ratingsDb = {
      executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
      lockRaterCreditOnMatter: jest.fn(),
      getRatingsOnMatter: jest.fn().mockResolvedValue([]),
      applyBulkIdentityUpdates: jest.fn()
    };
    const ratings = new RatingsService(
      ratingsDb as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      ratingsIdentitiesDb as any,
      {} as any
    );
    jest
      .spyOn(ratings as any, 'updateRatingInternal')
      .mockImplementation(async () => {
        onRate();
        return { identityUpdates: [] };
      });
    const nested = jest.spyOn(
      profilesService,
      'createOrUpdateProfileWithGivenTransaction'
    );
    const run = () =>
      ratings.bulkRateProfiles(AuthenticationContext.fromProfileId('rater'), {
        matter: 'REP',
        category: 'Category',
        amount_to_add: 1,
        target_wallet_addresses: wallets
      } as any);
    return {
      tx,
      nested,
      run,
      markProfilesMade: () => {
        profilesMade = true;
      }
    };
  }

  it('registers on the rating transaction and checks once, at its COMMIT, however many profiles it makes', async () => {
    let clockReadsAtWorkEnd = 0;
    let clockReadsAtCommit = -1;
    const rating = ratingTransaction([WALLET, OTHER_WALLET], () => {
      clockReadsAtWorkEnd = clock.spy.mock.calls.length;
    });
    stubProfileWrites(false, () => undefined);
    jest
      .spyOn(profilesDb, 'insertProfileRecord')
      .mockImplementation(async () => rating.markProfilesMade());
    const commit = rating.tx.connection.commit.bind(rating.tx.connection);
    jest.spyOn(rating.tx.connection, 'commit').mockImplementation(((
      callback: any
    ) => {
      clockReadsAtCommit = clock.spy.mock.calls.length;
      return commit(callback);
    }) as any);

    await rating.run();

    expect(rating.nested).toHaveBeenCalledTimes(2);
    for (const call of rating.nested.mock.calls) {
      expect(call[1].connection?.connection).toBe(rating.tx.connection);
    }
    expectCommitted(rating.tx.statements);
    expect(rating.tx.statements.filter((it) => it === 'BEGIN')).toHaveLength(1);
    // The rating and both profiles registered the same check: it ran once.
    expect(clockReadsAtCommit - clockReadsAtWorkEnd).toBe(1);
  });

  it('does not check when the nested profile write returns, only at the outer COMMIT', async () => {
    const rating = ratingTransaction([WALLET], () => undefined);
    stubProfileWrites(false, () => undefined);
    // T passes while the nested profile write waits on its lock.
    jest
      .spyOn(profilesDb, 'insertProfileRecord')
      .mockImplementation(async () => {
        rating.markProfilesMade();
        clock.pass();
      });

    await expectRefusedAtCommit(rating.run(), rating.tx.statements);

    expect(rating.nested).toHaveBeenCalledTimes(1);
    await expect(rating.nested.mock.results[0].value).resolves.toBeDefined();
  });
});
