import { RateMatter } from '@/entities/IRating';
import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import {
  isIdentityRatingMatter,
  overRateMattersOutsideFreeze,
  RatingsService
} from './ratings.service';

const FLAG = 'FEATURE_IDENTITY_FROZEN';
const PAST_FREEZE = 'reached the rating transaction after the freeze check';

function createService() {
  const ratingsDb = {
    executeNativeQueriesInTransaction: jest
      .fn()
      .mockRejectedValue(new Error(PAST_FREEZE)),
    getOverRateMatters: jest.fn()
  };
  const identitiesDb = {
    executeNativeQueriesInTransaction: jest
      .fn()
      .mockRejectedValue(new Error(PAST_FREEZE))
  };
  const service = new RatingsService(
    ratingsDb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    identitiesDb as any,
    {} as any
  );
  return { service, ratingsDb, identitiesDb };
}

function rateRequest(matter: RateMatter) {
  return {
    matter,
    matter_category: 'Category',
    matter_target_id: 'target',
    rating: 1,
    authenticationContext: {} as any
  } as any;
}

describe('ratings during the identity freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('counts REP and NIC as identity ratings, not wave REP', () => {
    expect(isIdentityRatingMatter(RateMatter.REP)).toBe(true);
    expect(isIdentityRatingMatter(RateMatter.CIC)).toBe(true);
    expect(isIdentityRatingMatter(RateMatter.WAVE_REP)).toBe(false);
  });

  it('leaves REP and NIC over-rates alone only while frozen', () => {
    const matters = [RateMatter.REP, RateMatter.CIC, RateMatter.WAVE_REP].map(
      (matter) => ({
        rater_profile_id: 'rater',
        matter,
        tally: 10,
        rater_credit: 1
      })
    );
    expect(overRateMattersOutsideFreeze(matters, false)).toEqual(matters);
    expect(overRateMattersOutsideFreeze(matters, true)).toEqual([matters[2]]);
  });

  it.each([RateMatter.REP, RateMatter.CIC])(
    'refuses a %s rating before its transaction',
    async (matter) => {
      process.env[FLAG] = 'true';
      const { service, ratingsDb } = createService();
      await expect(
        service.updateRating(rateRequest(matter), {})
      ).rejects.toBeInstanceOf(IdentityFrozenException);
      expect(
        ratingsDb.executeNativeQueriesInTransaction
      ).not.toHaveBeenCalled();
    }
  );

  it('lets a wave REP rating through', async () => {
    process.env[FLAG] = 'true';
    const { service } = createService();
    await expect(
      service.updateRating(rateRequest(RateMatter.WAVE_REP), {})
    ).rejects.toThrow(PAST_FREEZE);
  });

  it('refuses bulk REP and bulk REP or NIC rating', async () => {
    process.env[FLAG] = 'true';
    const { service, ratingsDb, identitiesDb } = createService();
    await expect(
      service.bulkRep({ targets: [] } as any, {})
    ).rejects.toBeInstanceOf(IdentityFrozenException);
    for (const matter of ['REP', 'CIC']) {
      await expect(
        service.bulkRateProfiles({} as any, { matter } as any)
      ).rejects.toBeInstanceOf(IdentityFrozenException);
    }
    expect(ratingsDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(
      identitiesDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
  });

  it('rates as before when the flag is off', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.updateRating(rateRequest(RateMatter.REP), {})
    ).rejects.toThrow(PAST_FREEZE);
  });
});
