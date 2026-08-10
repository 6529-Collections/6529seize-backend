import {
  MINIMUM_SUBSCRIPTION_ELIGIBILITY,
  normalizeSubscriptionEligibility
} from './subscription-eligibility';

describe('normalizeSubscriptionEligibility', () => {
  it.each([
    [-1, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [Number.NaN, 1],
    [1.5, 1]
  ])('normalizes %s Meme sets to eligibility %s', (memeSets, expected) => {
    expect(normalizeSubscriptionEligibility(memeSets)).toBe(expected);
  });

  it('exports the operational minimum eligibility', () => {
    expect(MINIMUM_SUBSCRIPTION_ELIGIBILITY).toBe(1);
  });
});
