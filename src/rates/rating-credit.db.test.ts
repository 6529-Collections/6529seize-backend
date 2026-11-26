import 'reflect-metadata';
import { ProfileRepOverviewDb } from '@/api/profiles/profile-rep-overview.db';
import { RateMatter } from '@/entities/IRating';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import { RatingsDb } from './ratings.db';

const CREDITS = 'Help6529 Credits';

async function onChain<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  const original = process.env.FEATURE_IDENTITY_ON_CHAIN;
  if (on) process.env.FEATURE_IDENTITY_ON_CHAIN = 'true';
  else delete process.env.FEATURE_IDENTITY_ON_CHAIN;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.FEATURE_IDENTITY_ON_CHAIN;
    else process.env.FEATURE_IDENTITY_ON_CHAIN = original;
  }
}

describeWithSeed(
  "the help bot's credits in REP reads",
  withRatings([
    aRepRating({
      rater_profile_id: 'someone',
      matter_target_id: 'alice',
      matter_category: 'Kind',
      rating: 5
    }),
    aRepRating({
      rater_profile_id: 'help-bot',
      matter_target_id: 'alice',
      matter_category: CREDITS,
      rating: 7
    }),
    aRepRating({
      rater_profile_id: 'help-bot',
      matter_target_id: 'alice',
      matter_category: ' help6529 credits ',
      rating: 3
    })
  ]),
  () => {
    const ratings = new RatingsDb(() => sqlExecutor);
    const overview = new ProfileRepOverviewDb(() => sqlExecutor);
    const total = (category: string | null) =>
      ratings.getRepRating(
        { rater_profile_id: null, target_profile_id: 'alice', category },
        {}
      );

    it('counts the credits in REP totals before switch-on', async () => {
      expect(Number(await onChain(false, () => total(null)))).toBe(15);
    });

    it('leaves the credits out of REP totals from switch-on, in any case or spacing', async () => {
      expect(Number(await onChain(true, () => total(null)))).toBe(5);
    });

    it('still serves the credit category when asked for by name', async () => {
      expect(Number(await onChain(true, () => total(CREDITS)))).toBe(7);
    });

    it('leaves the credits out of breakdowns and the overview from switch-on', async () => {
      await onChain(true, async () => {
        const categories =
          await ratings.getRatingStatsOnMatterGroupedByCategories({
            matter: RateMatter.REP,
            matter_target_id: 'alice',
            rater_profile_id: null
          } as never);
        expect(categories.map((it) => it.category)).toEqual(['Kind']);
        const stats = await overview.getRepOverviewStats({
          contextProfileId: 'alice',
          direction: 'incoming',
          authenticatedProfileId: null
        });
        expect(Number(stats.total_rep)).toBe(5);
      });
    });
  }
);
