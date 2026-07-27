import type { SubscriptionCoverageNotificationData } from '@/notifications/user-notification.types';
import { buildSubscriptionCoveragePushNotificationData } from './subscription-coverage-push-notification';

function coverageData(
  overrides: Partial<SubscriptionCoverageNotificationData> = {}
): SubscriptionCoverageNotificationData {
  return {
    recipient_profile_id: 'profile-1',
    profile_handle: 'alice',
    status: 'ACTION_REQUIRED',
    consolidation_key: '0xabc',
    mint_capacity: 2,
    allocated_mints: 2,
    fully_funded_drops: 0,
    funded_through: null,
    next_unfunded: {
      token_id: 528,
      mint_at: '2026-08-03T00:00:00.000Z',
      requested_mints: 3,
      funded_mints: 2,
      missing_mints: 1
    },
    minimum_top_up_eth: '0.06529',
    top_up_deadline: null,
    calculation_version: 1,
    forecast_fingerprint: 'risk-528-x3',
    ...overrides
  };
}

describe('buildSubscriptionCoveragePushNotificationData', () => {
  it('keeps early warnings in-app only', () => {
    expect(
      buildSubscriptionCoveragePushNotificationData(
        coverageData({ status: 'EARLY_WARNING' }),
        'alice'
      )
    ).toBeNull();
  });

  it('skips stale non-pushable coverage statuses', () => {
    const staleData = {
      ...coverageData(),
      status: 'COVERED'
    } as unknown as SubscriptionCoverageNotificationData;
    expect(
      buildSubscriptionCoveragePushNotificationData(staleData, 'alice')
    ).toBeNull();
  });

  it('builds a running-low push to the profile subscriptions tab', () => {
    expect(
      buildSubscriptionCoveragePushNotificationData(
        coverageData({
          status: 'RUNNING_LOW',
          fully_funded_drops: 3
        }),
        'alice'
      )
    ).toEqual({
      title: 'Subscription balance is running low',
      body: 'Your balance fully funds 3 intended drops.',
      data: {
        redirect: 'profile',
        handle: 'alice',
        subroute: 'subscriptions'
      },
      imageUrl: null
    });
  });

  it('includes the exact top-up amount for action-required coverage', () => {
    expect(
      buildSubscriptionCoveragePushNotificationData(coverageData(), 'alice')
    ).toEqual({
      title: 'Subscription top-up required',
      body: 'Meme #528 is not fully funded. Top up 0.06529 ETH to fully fund it.',
      data: {
        redirect: 'profile',
        handle: 'alice',
        subroute: 'subscriptions'
      },
      imageUrl: null
    });
  });
});
