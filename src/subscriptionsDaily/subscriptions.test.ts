import { NFTSubscription, SubscriptionMode } from '../entities/ISubscription';
import { resolveRequestedSubscriptionCount } from './subscriptions';

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
  });
});
