import 'reflect-metadata';
import { IDENTITIES_TABLE, RATINGS_TABLE } from '@/constants';
import { RateMatter } from '@/entities/IRating';
import { eventScheduler } from '@/events/event.scheduler';
import { ratingsDb } from '@/rates/ratings.db';
import { ratingsService } from '@/rates/ratings.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';

const goneRaterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000501';
const raterId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000502';
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000503';

function identity(profileId: string, address: string, tdh: number, rep = 0) {
  return anIdentity(
    { tdh, rep },
    {
      profile_id: profileId,
      consolidation_key: address,
      primary_address: address,
      handle: `handle-${address.slice(-3)}`
    }
  );
}

describeWithSeed(
  'over-rate revocation of a rater without an identity',
  [
    withIdentities([
      identity(raterId, '0x0000000000000000000000000000000000000502', 100),
      identity(targetId, '0x0000000000000000000000000000000000000503', 0, 35)
    ]),
    withRatings([
      aRepRating({
        rater_profile_id: goneRaterId,
        matter_target_id: targetId,
        matter_category: 'Art',
        rating: 25
      }),
      aRepRating({
        rater_profile_id: raterId,
        matter_target_id: targetId,
        matter_category: 'Art',
        rating: 10
      })
    ])
  ],
  () => {
    beforeEach(() => {
      jest
        .spyOn(eventScheduler, 'scheduleRepRatingChangedEvent')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reports the rater as having no credit', async () => {
      const matters = await ratingsDb.getOverRateMatters();

      expect(
        matters.map((it) => ({
          rater_profile_id: it.rater_profile_id,
          matter: it.matter,
          tally: Number(it.tally),
          rater_credit: Number(it.rater_credit)
        }))
      ).toEqual([
        {
          rater_profile_id: goneRaterId,
          matter: RateMatter.REP,
          tally: 25,
          rater_credit: 0
        }
      ]);
    });

    it('revokes its ratings and takes them off the target REP', async () => {
      await ratingsService.reduceOverRates();

      const ratings = await sqlExecutor.execute<{
        rater_profile_id: string;
        rating: number;
      }>(
        `select rater_profile_id, rating from ${RATINGS_TABLE}
         where matter_target_id = :targetId order by rater_profile_id`,
        { targetId }
      );
      expect(
        ratings.map((it) => [it.rater_profile_id, Number(it.rating)])
      ).toEqual([
        [goneRaterId, 0],
        [raterId, 10]
      ]);
      const target = await sqlExecutor.oneOrNull<{ rep: number }>(
        `select rep from ${IDENTITIES_TABLE} where profile_id = :targetId`,
        { targetId }
      );
      expect(Number(target?.rep)).toBe(10);
    });
  }
);
