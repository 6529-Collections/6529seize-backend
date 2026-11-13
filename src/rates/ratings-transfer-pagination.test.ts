import 'reflect-metadata';
import * as fc from 'fast-check';
import { RateMatter, Rating } from '@/entities/IRating';
import { RatingsService } from '@/rates/ratings.service';

jest.mock('@/notifications/user.notifier', () => ({
  userNotifier: {
    notifyOfIdentityRep: jest.fn(),
    notifyOfIdentityNic: jest.fn()
  }
}));

const SOURCE = 'source-profile';
const TARGET = 'target-profile';

function key(rating: Omit<Rating, 'last_modified'>): string {
  return JSON.stringify([
    rating.rater_profile_id,
    rating.matter_target_id,
    rating.matter,
    rating.matter_category
  ]);
}

/** Ratings in memory, read a page at a time like the database queries. */
function fakeRatingsDb(initial: Rating[], { zeroes = true } = {}) {
  const rows = new Map(initial.map((rating) => [key(rating), { ...rating }]));
  const page = (
    ratings: Rating[],
    pageRequest: { page: number; page_size: number }
  ) => {
    const offset = (pageRequest.page - 1) * pageRequest.page_size;
    return ratings
      .slice(offset, offset + pageRequest.page_size)
      .map((rating) => ({ ...rating }));
  };
  return {
    rows,
    getNonZeroRatingsForProfileOlderFirst: jest.fn(
      async ({
        rater_profile_id,
        page_request
      }: {
        rater_profile_id: string;
        page_request: { page: number; page_size: number };
      }) =>
        page(
          Array.from(rows.values()).filter(
            (it) => it.rater_profile_id === rater_profile_id && it.rating !== 0
          ),
          page_request
        )
    ),
    getNonZeroRatingsForMatterAndTargetIdOlderFirst: jest.fn(
      async ({
        matter_target_id,
        matters,
        page_request
      }: {
        matter_target_id: string;
        matters: RateMatter[];
        page_request: { page: number; page_size: number };
      }) =>
        page(
          Array.from(rows.values()).filter(
            (it) =>
              it.matter_target_id === matter_target_id &&
              matters.includes(it.matter) &&
              it.rating !== 0
          ),
          page_request
        )
    ),
    getRating: jest.fn(async (request: Omit<Rating, 'last_modified'>) => {
      if (!rows.has(key(request))) {
        rows.set(key(request), {
          ...request,
          rating: 0,
          last_modified: new Date()
        });
      }
      return { ...rows.get(key(request))!, total_credit_spent_on_matter: 0 };
    }),
    updateRating: jest.fn(async (request: Omit<Rating, 'last_modified'>) => {
      if (zeroes || request.rating !== 0) {
        rows.get(key(request))!.rating = request.rating;
      }
      return null;
    }),
    getTotalRatingForMatter: jest.fn().mockResolvedValue(0),
    applyBulkIdentityUpdates: jest.fn().mockResolvedValue(undefined)
  };
}

function createService(ratingsDb: ReturnType<typeof fakeRatingsDb>) {
  return new RatingsService(
    ratingsDb as any,
    {} as any,
    {
      scheduleRepRatingChangedEvent: jest.fn(),
      scheduleCicRatingChangedEvent: jest.fn()
    } as any,
    {} as any,
    {} as any,
    { migrateMatterTargetId: jest.fn() } as any,
    {} as any,
    { getProfileHandlesByIds: jest.fn().mockResolvedValue({}) } as any,
    {} as any
  );
}

function aRating(
  rater: string,
  target: string,
  i: number,
  rating: number
): Rating {
  return {
    rater_profile_id: rater,
    matter_target_id: target,
    matter: i % 2 ? RateMatter.CIC : RateMatter.REP,
    matter_category: i % 2 ? 'CIC' : `category-${i}`,
    rating,
    last_modified: new Date()
  };
}

const nonZero = fc
  .integer({ min: 1, max: 1000 })
  .chain((value) => fc.constantFrom(value, -value));

describe('profile merge moves every rating, however many pages', () => {
  it('moves all ratings the source gave', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2600 }),
        nonZero,
        async (count, rating) => {
          const given = Array.from({ length: count }, (_, i) =>
            aRating(SOURCE, `rated-${i}`, i, rating)
          );
          const ratingsDb = fakeRatingsDb(given);

          await createService(ratingsDb).transferAllGivenProfileRatings(
            SOURCE,
            TARGET,
            {} as any
          );

          const rows = Array.from(ratingsDb.rows.values());
          expect(
            rows.filter((it) => it.rater_profile_id === SOURCE && it.rating)
          ).toEqual([]);
          expect(
            rows.filter((it) => it.rater_profile_id === TARGET && it.rating)
          ).toHaveLength(count);
        }
      ),
      { numRuns: 12 }
    );
  });

  it('moves all ratings the source received', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2600 }),
        nonZero,
        async (count, rating) => {
          const received = Array.from({ length: count }, (_, i) =>
            aRating(`rater-${i}`, SOURCE, i, rating)
          );
          const ratingsDb = fakeRatingsDb(received);

          await createService(ratingsDb).transferAllReceivedProfileRatings(
            SOURCE,
            TARGET,
            {} as any
          );

          const rows = Array.from(ratingsDb.rows.values());
          expect(
            rows.filter((it) => it.matter_target_id === SOURCE && it.rating)
          ).toEqual([]);
          expect(
            rows.filter((it) => it.matter_target_id === TARGET && it.rating)
          ).toHaveLength(count);
        }
      ),
      { numRuns: 12 }
    );
  });

  it('fails instead of repeating a rating that was not zeroed', async () => {
    const ratingsDb = fakeRatingsDb([aRating(SOURCE, 'rated', 0, 5)], {
      zeroes: false
    });

    await expect(
      createService(ratingsDb).transferAllGivenProfileRatings(
        SOURCE,
        TARGET,
        {} as any
      )
    ).rejects.toThrow('is still non-zero after its transfer');
    expect(
      ratingsDb.getNonZeroRatingsForProfileOlderFirst
    ).toHaveBeenCalledTimes(2);
  });
});
