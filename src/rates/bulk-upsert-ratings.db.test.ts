import 'reflect-metadata';
import { RATINGS_TABLE } from '@/constants';
import { RateMatter } from '@/entities/IRating';
import { identityTdhSyncScopeDb } from '@/identity-tdh-sync-scope.db';
import { ratingsDb } from '@/rates/ratings.db';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';

const OLD = new Date('2020-01-01T00:00:00Z');

async function secondsSinceModified(target: string): Promise<number> {
  const [row] = await sqlExecutor.execute<{ age: number | string }>(
    `select timestampdiff(second, last_modified, now()) as age
     from ${RATINGS_TABLE} where matter_target_id = :target`,
    { target }
  );
  return Number(row.age);
}

describeWithSeed(
  'bulk REP rating upserts',
  withRatings([
    aRepRating({
      rater_profile_id: 'rater',
      matter_target_id: 'existing',
      matter_category: 'art',
      rating: 5
    })
  ]),
  () => {
    it('stamps the database clock on insert and on update, so the identities sync finds both', async () => {
      const [{ now }] = await sqlExecutor.execute<{ now: number | string }>(
        `select unix_timestamp() as now`
      );

      await ratingsDb.bulkUpsertRatings(
        [
          {
            rater_profile_id: 'rater',
            matter_target_id: 'existing',
            matter: RateMatter.REP,
            matter_category: 'art',
            rating: 9,
            last_modified: OLD
          },
          {
            rater_profile_id: 'rater',
            matter_target_id: 'new',
            matter: RateMatter.REP,
            matter_category: 'art',
            rating: 3,
            last_modified: OLD
          }
        ],
        {} as RequestContext
      );

      for (const target of ['existing', 'new']) {
        expect(await secondsSinceModified(target)).toBeLessThan(60);
      }
      const [{ rating }] = await sqlExecutor.execute<{ rating: number }>(
        `select rating from ${RATINGS_TABLE} where matter_target_id = 'existing'`
      );
      expect(Number(rating)).toBe(9);
      await expect(
        identityTdhSyncScopeDb.findRatedProfilesSince(Number(now) - 1)
      ).resolves.toEqual(expect.arrayContaining(['existing', 'new']));
    });
  }
);
