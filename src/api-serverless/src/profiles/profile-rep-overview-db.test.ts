import 'reflect-metadata';
import { ProfileRepOverviewDb } from '@/api/profiles/profile-rep-overview.db';
import { RATINGS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';

const tiedCategories = Array.from({ length: 26 }, (_, index) => ({
  category: `Tie ${String(index).padStart(2, '0')}`,
  rating: index % 2 === 0 ? 10 : -10
}));
const mixedCategories = [
  { category: 'Large negative', rating: -93865 },
  { category: 'Other negative', rating: -50000 },
  { category: 'Positive', rating: 910 },
  ...tiedCategories,
  { category: 'Small', rating: 3 },
  { category: 'Cancelled', rating: 100 },
  { category: 'Removed', rating: 0 }
];

for (const direction of ['incoming', 'outgoing'] as const) {
  const ratingFor = (
    contextProfileId: string,
    category: string,
    rating: number,
    contributor = 'viewer'
  ) =>
    aRepRating({
      rater_profile_id:
        direction === 'incoming' ? contributor : contextProfileId,
      matter_target_id:
        direction === 'incoming' ? contextProfileId : contributor,
      matter_category: category,
      rating
    });

  describeWithSeed(
    `Profile REP categories (${direction})`,
    withRatings([
      ...mixedCategories.map(({ category, rating }) =>
        ratingFor('mixed', category, rating)
      ),
      ratingFor('mixed', 'Cancelled', -100, 'other'),
      ...[1, 100, 10].flatMap((rating) => [
        ratingFor('positive', `Category ${rating}`, rating),
        ratingFor('negative', `Category ${rating}`, -rating)
      ]),
      ratingFor('unrelated', 'Unrelated', 1000000)
    ]),
    () => {
      const db = new ProfileRepOverviewDb(() => sqlExecutor);
      const request = {
        contextProfileId: 'mixed',
        direction,
        authenticatedProfileId: null,
        page: 1,
        page_size: 25
      };

      it.each<[string | null, number | null]>([
        [null, null],
        ['viewer', -93865],
        ['mixed', 0],
        ['proxy', 0]
      ])(
        'orders net totals by magnitude regardless of viewer %s',
        async (authenticatedProfileId, contribution) => {
          const result = await db.getRepCategoriesPage({
            ...request,
            authenticatedProfileId
          });
          expect(result.data.slice(0, 5).map((row) => row.total_rep)).toEqual([
            -93865, -50000, 910, 10, -10
          ]);
          expect(result.data[0]).toEqual({
            category: 'Large negative',
            total_rep: -93865,
            contributor_count: 1,
            authenticated_user_contribution: contribution
          });
        }
      );

      it('keeps alphabetical ties across pages without missing or repeating categories', async () => {
        const first = await db.getRepCategoriesPage(request);
        const second = await db.getRepCategoriesPage({ ...request, page: 2 });
        const beyond = await db.getRepCategoriesPage({ ...request, page: 3 });
        expect(first).toMatchObject({ page: 1, next: true });
        expect(first.data).toHaveLength(25);
        expect(second).toMatchObject({ page: 2, next: false });
        expect(second.data).toHaveLength(6);
        expect(
          [...first.data, ...second.data].map((row) => row.category)
        ).toEqual([
          'Large negative',
          'Other negative',
          'Positive',
          ...tiedCategories.map(({ category }) => category),
          'Small',
          'Cancelled'
        ]);
        expect(second.data[second.data.length - 1]).toEqual({
          category: 'Cancelled',
          total_rep: 0,
          contributor_count: 2,
          authenticated_user_contribution: null
        });
        expect(beyond).toEqual({ page: 3, next: false, data: [] });
        expect(await db.getRepCategoriesPage(request)).toEqual(first);
      });

      it.each(['positive', 'negative'])(
        'orders a %s-only profile from largest magnitude to smallest',
        async (contextProfileId) => {
          const result = await db.getRepCategoriesPage({
            ...request,
            contextProfileId
          });
          expect(result.data.map((row) => row.category)).toEqual([
            'Category 100',
            'Category 10',
            'Category 1'
          ]);
          expect(result.next).toBe(false);
        }
      );

      it('reorders on a fresh query after a rating changes', async () => {
        await sqlExecutor.execute(
          `update ${RATINGS_TABLE} set rating = -100000
           where matter = 'REP' and matter_category = 'Small'`,
          {}
        );
        const result = await db.getRepCategoriesPage(request);
        expect(result.data[0]).toMatchObject({
          category: 'Small',
          total_rep: -100000
        });
      });

      it('returns an empty page for a profile without REP', async () => {
        expect(
          await db.getRepCategoriesPage({
            ...request,
            contextProfileId: 'empty'
          })
        ).toEqual({ page: 1, next: false, data: [] });
      });
    }
  );
}
