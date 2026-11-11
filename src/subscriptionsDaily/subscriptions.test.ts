import { NFTSubscription, SubscriptionMode } from '../entities/ISubscription';
import fc from 'fast-check';
import {
  resolveFinalSubscriptionCount,
  resolveRequestedSubscriptionCount
} from './subscriptions';

describe('subscriptionsDaily', () => {
  describe('resolveRequestedSubscriptionCount', () => {
    const buildSubscription = (
      subscribedCount: number,
      automaticSubscription: boolean
    ): NFTSubscription => ({
      consolidation_key: 'ck-1',
      contract: '0x123',
      token_id: 470,
      subscribed: true,
      subscribed_count: subscribedCount,
      automatic_subscription: automaticSubscription
    });

    const buildMode = (subscribeAllEditions: boolean): SubscriptionMode => ({
      consolidation_key: 'ck-1',
      automatic: true,
      subscribe_all_editions: subscribeAllEditions
    });

    it('uses current eligibility for untouched auto all-editions rows', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(1, true),
        buildMode(true),
        3
      );

      expect(result).toBe(3);
    });

    it('keeps manual overrides even when current eligibility is higher', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(1, false),
        buildMode(true),
        3
      );

      expect(result).toBe(1);
    });

    it('does not expand one-edition auto subscriptions', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(1, true),
        buildMode(false),
        3
      );

      expect(result).toBe(1);
    });

    it('defaults to the stored subscription count for manual rows', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(2, false),
        buildMode(true),
        3
      );

      expect(result).toBe(2);
    });

    it('defaults to the stored count when mode is undefined', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(2, true),
        undefined,
        3
      );

      expect(result).toBe(2);
    });

    it('returns zero when auto all-editions eligibility is zero', () => {
      const result = resolveRequestedSubscriptionCount(
        buildSubscription(2, true),
        buildMode(true),
        0
      );

      expect(result).toBe(0);
    });
  });
});

describe('resolveFinalSubscriptionCount', () => {
  it('takes the smallest of eligibility, request and affordability', () => {
    expect(resolveFinalSubscriptionCount(3, 2, 5)).toBe(2);
    expect(resolveFinalSubscriptionCount(1, 4, 5)).toBe(1);
    expect(resolveFinalSubscriptionCount(3, 3, 2)).toBe(2);
  });

  it('leaves out zero, negative and malformed counts', () => {
    expect(resolveFinalSubscriptionCount(3, 0, 5)).toBeNull();
    expect(resolveFinalSubscriptionCount(3, -2, 5)).toBeNull();
    expect(resolveFinalSubscriptionCount(0, 1, 5)).toBeNull();
    expect(resolveFinalSubscriptionCount(3, Number.NaN, 5)).toBeNull();
    expect(resolveFinalSubscriptionCount(3, 0.5, 5)).toBeNull();
  });

  it('rounds a fractional count down', () => {
    expect(resolveFinalSubscriptionCount(3, 1.5, 5)).toBe(1);
  });

  it('always returns null or an integer within every bound', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 50 }),
        fc.double({ min: -5, max: 50, noNaN: false }),
        fc.integer({ min: -5, max: 50 }),
        (eligibility, requested, affordable) => {
          const count = resolveFinalSubscriptionCount(
            eligibility,
            requested,
            affordable
          );
          if (count !== null) {
            expect(Number.isInteger(count)).toBe(true);
            expect(count).toBeGreaterThanOrEqual(1);
            expect(count).toBeLessThanOrEqual(
              Math.min(eligibility, requested, affordable)
            );
          }
        }
      )
    );
  });
});
