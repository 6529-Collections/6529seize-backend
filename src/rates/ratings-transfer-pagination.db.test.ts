import 'reflect-metadata';
import { RATINGS_TABLE } from '@/constants';
import { RateMatter, Rating } from '@/entities/IRating';
import { ratingsService } from '@/rates/ratings.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { withRatings } from '@/tests/fixtures/rating.fixture';

const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000601';
const targetId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000602';
// One more than a transfer page.
const GIVEN = 1001;

const given: Rating[] = Array.from({ length: GIVEN }, (_, i) => ({
  rater_profile_id: sourceId,
  matter_target_id: `wave-${String(i).padStart(4, '0')}`,
  matter: RateMatter.WAVE_REP,
  matter_category: 'Art',
  rating: 1,
  last_modified: new Date('2024-01-01T00:00:00Z')
}));

async function nonZeroRatingsBy(raterId: string): Promise<number> {
  const [row] = await sqlExecutor.execute<{ cnt: number }>(
    `select count(*) as cnt from ${RATINGS_TABLE}
     where rater_profile_id = :raterId and rating <> 0`,
    { raterId }
  );
  return Number(row.cnt);
}

describeWithSeed(
  'profile merge rating transfer over more than one page',
  withRatings(given),
  () => {
    it('moves every rating the source gave', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        ratingsService.transferAllGivenProfileRatings(
          sourceId,
          targetId,
          connection
        )
      );

      expect(await nonZeroRatingsBy(sourceId)).toBe(0);
      expect(await nonZeroRatingsBy(targetId)).toBe(GIVEN);
    }, 180_000);
  }
);
