import 'reflect-metadata';
import * as fc from 'fast-check';
import { AuthenticationContext } from '@/auth-context';
import { RateMatter, Rating } from '@/entities/IRating';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { profilesService } from '@/profiles/profiles.service';
import { RatingsService } from '@/rates/ratings.service';

const RATER = 'rater-a';
const OTHER_RATER = 'rater-b';
const TARGET = 'target-profile';
const TARGET_ADDRESS = '0x00000000000000000000000000000000000000aa';
const CATEGORY = 'Art';
const CONNECTION = { connection: 'tx' };

function aRating(rater: string, rating: number): Rating {
  return {
    rater_profile_id: rater,
    matter_target_id: TARGET,
    matter: RateMatter.REP,
    matter_category: CATEGORY,
    rating,
    last_modified: new Date()
  };
}

function createService({
  lockedRatings,
  credit,
  spent
}: {
  lockedRatings: Rating[];
  credit: number;
  spent: number;
}) {
  const ratingsDb = {
    lockRaterCreditOnMatter: jest.fn().mockResolvedValue(undefined),
    getRaterRepRatingsForUpdate: jest.fn().mockResolvedValue(lockedRatings),
    getTotalCreditSpent: jest.fn().mockResolvedValue(spent),
    bulkUpsertRatings: jest.fn().mockResolvedValue(undefined)
  };
  const identitiesDb = {
    executeNativeQueriesInTransaction: jest.fn(
      (fn: (connection: unknown) => Promise<unknown>) => fn(CONNECTION)
    ),
    getIdentityByProfileId: jest
      .fn()
      .mockResolvedValue({ consolidation_key: '0xrater' }),
    getTdhAndXTdhCombinedAndFloored: jest.fn().mockResolvedValue(credit),
    bulkUpdateReps: jest.fn().mockResolvedValue(undefined)
  };
  const eventScheduler = {
    scheduleBulkRepRatingChangedEvents: jest.fn().mockResolvedValue(undefined)
  };
  const abusivenessCheckService = {
    bulkCheckRepPhrases: jest.fn().mockResolvedValue(undefined)
  };
  const service = new RatingsService(
    ratingsDb as any,
    {} as any,
    eventScheduler as any,
    {} as any,
    {} as any,
    {} as any,
    abusivenessCheckService as any,
    identitiesDb as any,
    {} as any
  );
  return { service, ratingsDb, identitiesDb, eventScheduler };
}

async function bulkRep(service: RatingsService, amount: number) {
  await service.bulkRep(
    { targets: [{ address: TARGET_ADDRESS, category: CATEGORY, amount }] },
    { authenticationContext: AuthenticationContext.fromProfileId(RATER) }
  );
}

describe('bulk REP uses the rater own rating as the old rating', () => {
  beforeEach(() => {
    jest
      .spyOn(
        profilesService,
        'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
      )
      .mockResolvedValue({ [TARGET_ADDRESS]: TARGET });
    jest
      .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('locks only the rater ratings on the requested pairs', async () => {
    const { service, ratingsDb } = createService({
      lockedRatings: [aRating(RATER, 50)],
      credit: 1000,
      spent: 50
    });

    await bulkRep(service, 70);

    expect(ratingsDb.getRaterRepRatingsForUpdate).toHaveBeenCalledWith(
      {
        rater_profile_id: RATER,
        pairs: [{ matter_target_id: TARGET, matter_category: CATEGORY }]
      },
      expect.objectContaining({ connection: CONNECTION })
    );
  });

  it('spends only the change from the rater own rating when another rater rated the same target and category', async () => {
    // Another rater's 10 on the same pair is not this rater's old rating:
    // raising 50 to 70 spends 20, which the 100 credit (50 spent) allows.
    const { service, identitiesDb, ratingsDb, eventScheduler } = createService({
      lockedRatings: [aRating(OTHER_RATER, 10), aRating(RATER, 50)],
      credit: 100,
      spent: 50
    });

    await bulkRep(service, 70);

    expect(identitiesDb.bulkUpdateReps).toHaveBeenCalledWith(
      [{ profileId: TARGET, newRep: 20 }],
      expect.anything()
    );
    expect(ratingsDb.bulkUpsertRatings).toHaveBeenCalledWith(
      [expect.objectContaining({ rater_profile_id: RATER, rating: 70 })],
      expect.anything()
    );
    expect(
      eventScheduler.scheduleBulkRepRatingChangedEvents
    ).toHaveBeenCalledWith(
      [expect.objectContaining({ old_score: 50, new_score: 70 })],
      CONNECTION
    );
  });

  it('rejects an increase the rater has no credit for, whatever another rater gave', async () => {
    // Raising 50 to 60 needs 10 more credit; another rater's 90 on the same
    // pair must not make it look like a decrease.
    const { service, identitiesDb, ratingsDb } = createService({
      lockedRatings: [aRating(OTHER_RATER, 90), aRating(RATER, 50)],
      credit: 50,
      spent: 50
    });

    await expect(bulkRep(service, 60)).rejects.toThrow(
      'Not enough credit left to go through with this bulk rating'
    );
    expect(ratingsDb.bulkUpsertRatings).not.toHaveBeenCalled();
    expect(identitiesDb.bulkUpdateReps).not.toHaveBeenCalled();
  });

  it('moves the target REP by the new rating less the rater own rating', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 4 }),
        fc.integer({ min: -1000, max: 1000 }),
        async (own, others, amount) => {
          const lockedRatings = [
            ...others.map((rating, i) => aRating(`other-${i}`, rating)),
            ...(own === undefined ? [] : [aRating(RATER, own)])
          ];
          const { service, identitiesDb, ratingsDb } = createService({
            lockedRatings,
            credit: 1_000_000,
            spent: 0
          });

          await bulkRep(service, amount);

          const [updates] = identitiesDb.bulkUpdateReps.mock.calls[0];
          expect(updates).toEqual([
            { profileId: TARGET, newRep: amount - (own ?? 0) }
          ]);
          // Other raters' locked rows only exist as noise: none of them may
          // be written back.
          const upsertedRows: Rating[] =
            ratingsDb.bulkUpsertRatings.mock.calls.flatMap(
              ([rows]: [Rating[]]) => rows
            );
          for (const row of upsertedRows) {
            expect(row.rater_profile_id).toBe(RATER);
            expect(row.rating).toBe(amount);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
