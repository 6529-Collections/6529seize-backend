import 'reflect-metadata';
import { sqlExecutor } from '../sql-executor';
import { describeWithSeed } from '../tests/_setup/seed';
import { aRepRating, withRatings } from '../tests/fixtures/rating.fixture';
import { RatingsDb } from './ratings.db';
import { RequestContext } from '../request.context';

describeWithSeed(
  'RatingsDb',
  withRatings([
    aRepRating({
      rater_profile_id: 'rater-1',
      matter_target_id: 'target-1',
      matter_category: 'LEADERSHIP',
      rating: -7
    }),
    aRepRating({
      rater_profile_id: 'rater-2',
      matter_target_id: 'target-1',
      matter_category: 'LEADERSHIP',
      rating: -5
    }),
    aRepRating({
      rater_profile_id: 'rater-3',
      matter_target_id: 'target-1',
      matter_category: 'STRATEGY',
      rating: 8
    }),
    aRepRating({
      rater_profile_id: 'rater-4',
      matter_target_id: 'target-1',
      matter_category: 'EXECUTION',
      rating: 8
    }),
    aRepRating({
      rater_profile_id: 'rater-5',
      matter_target_id: 'target-2',
      matter_category: 'EMPATHY',
      rating: 4
    }),
    aRepRating({
      rater_profile_id: 'rater-6',
      matter_target_id: 'target-2',
      matter_category: 'VISION',
      rating: -4
    }),
    aRepRating({
      rater_profile_id: 'rater-7',
      matter_target_id: 'target-2',
      matter_category: 'CRAFT',
      rating: -3
    }),
    aRepRating({
      rater_profile_id: 'rater-8',
      matter_target_id: 'target-3',
      matter_category: 'FLAT',
      rating: 3
    }),
    aRepRating({
      rater_profile_id: 'rater-9',
      matter_target_id: 'target-3',
      matter_category: 'FLAT',
      rating: -3
    }),
    aRepRating({
      rater_profile_id: 'rater-10',
      matter_target_id: 'target-3',
      matter_category: 'REAL',
      rating: 1
    })
  ]),
  () => {
    const repo = new RatingsDb(() => sqlExecutor);
    const ctx: RequestContext = { timer: undefined };

    it('returns the top rep categories by absolute summed rep per target', async () => {
      const results = await repo.getTopAbsoluteRepCategoriesByTargetIds(
        {
          targetIds: ['target-1', 'target-2'],
          limitPerTarget: 2
        },
        ctx
      );

      expect(results).toEqual([
        {
          profile_id: 'target-1',
          category: 'LEADERSHIP',
          rep: -12
        },
        {
          profile_id: 'target-1',
          category: 'EXECUTION',
          rep: 8
        },
        {
          profile_id: 'target-2',
          category: 'EMPATHY',
          rep: 4
        },
        {
          profile_id: 'target-2',
          category: 'VISION',
          rep: -4
        }
      ]);
    });

    it('filters out zero-net categories before ranking', async () => {
      const results = await repo.getTopAbsoluteRepCategoriesByTargetIds(
        {
          targetIds: ['target-3'],
          limitPerTarget: 2
        },
        ctx
      );

      expect(results).toEqual([
        {
          profile_id: 'target-3',
          category: 'REAL',
          rep: 1
        }
      ]);
    });
  }
);
