import 'reflect-metadata';
import { IDENTITIES_TABLE, RATINGS_TABLE } from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import { eventScheduler } from '@/events/event.scheduler';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { abusivenessCheckService } from '@/profiles/abusiveness-check.service';
import { profilesService } from '@/profiles/profiles.service';
import { ratingsDb } from '@/rates/ratings.db';
import { ratingsService } from '@/rates/ratings.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';

const raterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000401';
// Sorts before the rater: a lookup over all raters finds this row first.
const otherRaterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000400';
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000403';
const targetAddress = '0x0000000000000000000000000000000000000403';

function identity(
  profileId: string,
  address: string,
  values: { tdh?: number; rep?: number }
) {
  return anIdentity(values, {
    profile_id: profileId,
    consolidation_key: address,
    primary_address: address,
    handle: `handle-${address.slice(-3)}`
  });
}

async function bulkRep(amount: number) {
  await ratingsService.bulkRep(
    { targets: [{ address: targetAddress, category: 'Art', amount }] },
    { authenticationContext: AuthenticationContext.fromProfileId(raterId) }
  );
}

async function state() {
  const ratings = await sqlExecutor.execute<{
    rater_profile_id: string;
    rating: number;
  }>(
    `select rater_profile_id, rating from ${RATINGS_TABLE}
     where matter = 'REP' and matter_target_id = :targetId and matter_category = 'Art'
     order by rater_profile_id`,
    { targetId }
  );
  const target = await sqlExecutor.oneOrNull<{ rep: number }>(
    `select rep from ${IDENTITIES_TABLE} where profile_id = :targetId`,
    { targetId }
  );
  return {
    ratings: ratings.map((it) => [it.rater_profile_id, Number(it.rating)]),
    targetRep: Number(target?.rep)
  };
}

describeWithSeed(
  'bulk REP with another rater on the same target and category',
  [
    withIdentities([
      identity(raterId, '0x0000000000000000000000000000000000000401', {
        tdh: 100
      }),
      identity(otherRaterId, '0x0000000000000000000000000000000000000400', {
        tdh: 200
      }),
      identity(targetId, targetAddress, { rep: 150 })
    ]),
    withRatings([
      aRepRating({
        rater_profile_id: otherRaterId,
        matter_target_id: targetId,
        matter_category: 'Art',
        rating: 150
      })
    ])
  ],
  () => {
    beforeEach(() => {
      jest
        .spyOn(
          profilesService,
          'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
        )
        .mockResolvedValue({ [targetAddress]: targetId });
      jest
        .spyOn(abusivenessCheckService, 'bulkCheckRepPhrases')
        .mockResolvedValue(undefined);
      jest
        .spyOn(eventScheduler, 'scheduleBulkRepRatingChangedEvents')
        .mockResolvedValue(undefined);
      jest
        .spyOn(profileActivityLogsDb, 'bulkInsertProfileActivityLogs')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('changes the target REP by the rater own change only', async () => {
      await bulkRep(30);
      expect(await state()).toEqual({
        ratings: [
          [otherRaterId, 150],
          [raterId, 30]
        ],
        targetRep: 180
      });

      await bulkRep(10);
      expect(await state()).toEqual({
        ratings: [
          [otherRaterId, 150],
          [raterId, 10]
        ],
        targetRep: 160
      });
    });

    it('checks the credit against the rater own old rating', async () => {
      await bulkRep(100);
      // 100 spent of 100: raising to 101 needs credit the rater no longer
      // has. Measured from the other rater's 150 it would look like a cut.
      await expect(bulkRep(101)).rejects.toThrow(
        'Not enough credit left to go through with this bulk rating'
      );
      expect(await state()).toEqual({
        ratings: [
          [otherRaterId, 150],
          [raterId, 100]
        ],
        targetRep: 250
      });
    });

    it('reads and locks only the rater rows, creating the missing ones at zero', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          const rows = await ratingsDb.getRaterRepRatingsForUpdate(
            {
              rater_profile_id: raterId,
              pairs: [{ matter_target_id: targetId, matter_category: 'Art' }]
            },
            { connection }
          );
          expect(
            rows.map((it) => [it.rater_profile_id, Number(it.rating)])
          ).toEqual([[raterId, 0]]);
          throw new Error('deliberate rollback');
        })
      ).rejects.toThrow('deliberate rollback');
      expect((await state()).ratings).toEqual([[otherRaterId, 150]]);
    });
  }
);
