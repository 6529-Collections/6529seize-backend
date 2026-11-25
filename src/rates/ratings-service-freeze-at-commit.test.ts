import { AuthenticationContext } from '@/auth-context';
import { RateMatter } from '@/entities/IRating';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { profilesService } from '@/profiles/profiles.service';
import {
  expectCommitted,
  expectRefusedAtCommit,
  fakeTransactionalDb,
  freezeClock
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { RatingsService } from './ratings.service';

const WALLET = '0x1111111111111111111111111111111111111111';
const RATER = 'rater-profile-id';
const TARGET = 'target-profile-id';

/**
 * A ratings service whose ratings and identities share one transaction run
 * by the real my-sql.helpers on a fake connection. `onLock` runs where the
 * transaction would wait on its first row lock.
 */
function setup(onLock: () => void) {
  const tx = fakeTransactionalDb();
  const ratingsDb = {
    executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
    lockRaterCreditOnMatter: jest.fn(async () => onLock()),
    applyBulkIdentityUpdates: jest.fn(),
    getRatingsOnMatter: jest.fn().mockResolvedValue([]),
    getRaterRepRatingsForUpdate: jest.fn().mockResolvedValue([]),
    getTotalCreditSpent: jest.fn().mockResolvedValue(0),
    bulkUpsertRatings: jest.fn()
  };
  const identitiesDb = {
    executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
    getEverythingRelatedToIdentitiesByAddresses: jest.fn().mockResolvedValue({
      [WALLET]: {
        identity: { primary_address: WALLET, profile_id: TARGET },
        profile: { external_id: TARGET },
        consolidations: []
      }
    }),
    insertIdentity: jest.fn(),
    getIdentityByProfileId: jest.fn().mockResolvedValue(null),
    getTdhAndXTdhCombinedAndFloored: jest.fn().mockResolvedValue(1_000),
    bulkUpdateReps: jest.fn()
  };
  const eventScheduler = { scheduleBulkRepRatingChangedEvents: jest.fn() };
  const abusivenessCheckService = { bulkCheckRepPhrases: jest.fn() };
  const metricsRecorder = { recordActiveIdentity: jest.fn() };
  const service = new RatingsService(
    ratingsDb as any,
    {} as any,
    eventScheduler as any,
    {} as any,
    {} as any,
    {} as any,
    abusivenessCheckService as any,
    identitiesDb as any,
    metricsRecorder as any
  );
  // The single rating write; for updateRating it is also where the
  // transaction waits on its lock.
  const rate = jest
    .spyOn(service as any, 'updateRatingInternal')
    .mockImplementation(async () => {
      onLock();
      return { identityUpdates: [] };
    });
  jest
    .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
    .mockResolvedValue(undefined as any);
  return { service, tx, ratingsDb, rate };
}

const rater = () => AuthenticationContext.fromProfileId(RATER);

describe('a rating admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  function rateRequest(matter: RateMatter) {
    return {
      matter,
      matter_category: 'Category',
      matter_target_id: TARGET,
      rating: 1,
      authenticationContext: rater()
    } as any;
  }

  it.each([RateMatter.REP, RateMatter.CIC])(
    'updateRating refuses a %s rating at COMMIT and rolls it back',
    async (matter) => {
      const { service, tx, rate } = setup(() => clock.pass());
      await expectRefusedAtCommit(
        service.updateRating(rateRequest(matter), {}),
        tx.statements
      );
      expect(rate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          connection: expect.objectContaining({ connection: tx.connection })
        })
      );
    }
  );

  it.each([RateMatter.REP, RateMatter.CIC])(
    'updateRating commits a %s rating that ends before T',
    async (matter) => {
      const { service, tx } = setup(() => undefined);
      await service.updateRating(rateRequest(matter), {});
      expectCommitted(tx.statements);
    }
  );

  it('updateRating does not check a wave REP rating at COMMIT', async () => {
    const { service, tx } = setup(() => clock.pass());
    await service.updateRating(rateRequest(RateMatter.WAVE_REP), {});
    expectCommitted(tx.statements);
  });

  it.each(['REP', 'CIC'])(
    'bulkRateProfiles refuses a bulk %s rating at COMMIT and rolls it back',
    async (matter) => {
      const { service, tx, rate } = setup(() => clock.pass());
      await expectRefusedAtCommit(
        service.bulkRateProfiles(rater(), {
          matter,
          category: 'Category',
          amount_to_add: 1,
          target_wallet_addresses: [WALLET]
        } as any),
        tx.statements
      );
      expect(rate).toHaveBeenCalledTimes(1);
    }
  );

  it('bulkRateProfiles commits a bulk REP rating that ends before T', async () => {
    const { service, tx } = setup(() => undefined);
    await expect(
      service.bulkRateProfiles(rater(), {
        matter: 'REP',
        category: 'Category',
        amount_to_add: 1,
        target_wallet_addresses: [WALLET]
      } as any)
    ).resolves.toEqual({ skipped: [] });
    expectCommitted(tx.statements);
  });

  describe('bulkRep', () => {
    function bulkRep(service: RatingsService) {
      return service.bulkRep(
        { targets: [{ address: WALLET, category: 'Category', amount: 5 }] },
        { authenticationContext: rater() }
      );
    }

    beforeEach(() => {
      jest
        .spyOn(
          profilesService,
          'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
        )
        .mockResolvedValue({ [WALLET]: TARGET });
    });

    it('refuses at COMMIT and rolls back every rating it wrote', async () => {
      const { service, tx, ratingsDb } = setup(() => clock.pass());
      await expectRefusedAtCommit(bulkRep(service), tx.statements);
      expect(ratingsDb.bulkUpsertRatings).toHaveBeenCalledTimes(1);
    });

    it('commits when it ends before T', async () => {
      const { service, tx, ratingsDb } = setup(() => undefined);
      await bulkRep(service);
      expectCommitted(tx.statements);
      expect(ratingsDb.bulkUpsertRatings).toHaveBeenCalledTimes(1);
    });
  });
});
