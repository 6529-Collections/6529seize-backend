const mockSendIdentityPushNotifications = jest.fn();

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: mockSendIdentityPushNotifications
}));

import { SubscriptionCoverageStatus } from '@/subscription-coverage';
import { MemeCalendarScheduleProvider } from './meme-calendar-schedule.provider';
import { SubscriptionCoverageReconciliationService } from './subscription-coverage-reconciliation.service';
import {
  SubscriptionCoverageRepository,
  SubscriptionCoverageSourceData
} from './subscription-coverage.repository';

describe('SubscriptionCoverageReconciliationService reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns UNKNOWN when the projected calendar is unavailable', async () => {
    const source: SubscriptionCoverageSourceData = {
      consolidationKey: 'profile-key',
      hasDemonstratedIntent: true,
      balanceEth: '0.06529',
      mode: {
        automatic: true,
        subscribeAllEditions: false
      },
      eligibilityCount: 1,
      selections: []
    };
    const repository = {
      loadSourceData: jest.fn(async () => new Map([['profile-key', source]])),
      resolveCanonicalProfiles: jest.fn(async () => new Map())
    } as unknown as SubscriptionCoverageRepository;
    const scheduleProvider = {
      getSchedule: jest.fn(async () => {
        throw new Error('calendar offline');
      })
    } as unknown as MemeCalendarScheduleProvider;
    const service = new SubscriptionCoverageReconciliationService(
      repository,
      scheduleProvider,
      () => Date.parse('2026-07-26T22:00:00.000Z')
    );

    const forecast = await service.calculateCoverage('PROFILE-KEY');

    expect(forecast.status).toBe(SubscriptionCoverageStatus.Unknown);
    expect(forecast.fundedThrough).toBeNull();
    expect(forecast.nextUnfunded).toBeNull();
    expect(forecast.minimumTopUp).toBeNull();
    expect(forecast.recommendedTopUp).toBeNull();
    expect(repository.loadSourceData).toHaveBeenCalledWith(
      ['profile-key'],
      [],
      {}
    );
  });

  it('keeps manual users without selections neutral when calendar is unavailable', async () => {
    const source: SubscriptionCoverageSourceData = {
      consolidationKey: 'manual-key',
      hasDemonstratedIntent: true,
      balanceEth: '0',
      mode: {
        automatic: false,
        subscribeAllEditions: false
      },
      eligibilityCount: 1,
      selections: []
    };
    const repository = {
      loadSourceData: jest.fn(async () => new Map([['manual-key', source]])),
      resolveCanonicalProfiles: jest.fn(async () => new Map())
    } as unknown as SubscriptionCoverageRepository;
    const scheduleProvider = {
      getSchedule: jest.fn(async () => {
        throw new Error('calendar offline');
      })
    } as unknown as MemeCalendarScheduleProvider;
    const service = new SubscriptionCoverageReconciliationService(
      repository,
      scheduleProvider,
      () => Date.parse('2026-07-26T22:00:00.000Z')
    );

    const forecast = await service.calculateCoverage('manual-key');

    expect(forecast.status).toBe(
      SubscriptionCoverageStatus.NoUpcomingSelections
    );
  });

  it('returns UNKNOWN for a manual selection when its schedule is unavailable', async () => {
    const source: SubscriptionCoverageSourceData = {
      consolidationKey: 'selected-key',
      hasDemonstratedIntent: true,
      balanceEth: '0.06529',
      mode: {
        automatic: false,
        subscribeAllEditions: false
      },
      eligibilityCount: 1,
      selections: [
        {
          tokenId: 528,
          subscribed: true,
          subscribedCount: 1,
          automaticSubscription: false
        }
      ]
    };
    const repository = {
      loadSourceData: jest.fn(async () => new Map([['selected-key', source]])),
      resolveCanonicalProfiles: jest.fn(async () => new Map())
    } as unknown as SubscriptionCoverageRepository;
    const scheduleProvider = {
      getSchedule: jest.fn(async () => {
        throw new Error('calendar offline');
      })
    } as unknown as MemeCalendarScheduleProvider;
    const service = new SubscriptionCoverageReconciliationService(
      repository,
      scheduleProvider,
      () => Date.parse('2026-07-26T22:00:00.000Z')
    );

    const forecast = await service.calculateCoverage('selected-key');

    expect(forecast.status).toBe(SubscriptionCoverageStatus.Unknown);
    expect(forecast.fundedThrough).toBeNull();
    expect(forecast.nextUnfunded).toBeNull();
  });

  it('skips row transactions for a materially unchanged full-scan snapshot', async () => {
    const source: SubscriptionCoverageSourceData = {
      consolidationKey: 'profile-key',
      hasDemonstratedIntent: true,
      balanceEth: '0',
      mode: {
        automatic: true,
        subscribeAllEditions: false
      },
      eligibilityCount: 1,
      selections: []
    };
    const applyAlertSnapshot = jest.fn();
    const repository = {
      listDemonstratedIntentKeys: jest.fn(async () => ['profile-key']),
      loadSourceData: jest.fn(async () => new Map([['profile-key', source]])),
      resolveCanonicalProfiles: jest.fn(async () => new Map()),
      readAlertStates: jest.fn(
        async () =>
          new Map([
            [
              'profile-key',
              {
                current_status: 'ACTION_REQUIRED',
                current_fingerprint: 'older-balance-fingerprint',
                current_at_risk_token_id: 528,
                current_fully_funded_drops: 0,
                current_requested_mints: 1,
                current_missing_mints: 1,
                recipient_profile_id: null,
                last_notified_status: null,
                last_notified_fingerprint: null,
                last_notified_at: null
              }
            ]
          ])
      ),
      applyAlertSnapshot
    } as unknown as SubscriptionCoverageRepository;
    const scheduleProvider = {
      getSchedule: jest.fn(async () => ({
        drops: Array.from({ length: 8 }, (_unused, index) => ({
          tokenId: 528 + index,
          mintAt: new Date(
            Date.parse('2026-07-27T14:40:00.000Z') + index * 24 * 60 * 60 * 1000
          ).toISOString(),
          topUpDeadline: null
        })),
        basis: 'PROJECTED',
        deadlineBasis: 'UNAVAILABLE',
        horizon: 8,
        fetchedAt: '2026-07-26T22:00:00.000Z',
        truncated: true
      }))
    } as unknown as MemeCalendarScheduleProvider;
    const service = new SubscriptionCoverageReconciliationService(
      repository,
      scheduleProvider,
      () => Date.parse('2026-07-26T22:00:00.000Z')
    );

    const result = await service.reconcileFullPage(undefined, 100, {
      dryRun: false,
      notificationsEnabled: true,
      baselineOnly: false,
      notifyInitialCritical: false,
      pushEnabled: true
    });

    expect(result).toMatchObject({
      scanned: 1,
      succeeded: 1,
      failed: 0,
      deduplicatedOrSuppressed: 1,
      notificationsCreated: 0,
      pushesQueued: 0
    });
    expect(applyAlertSnapshot).not.toHaveBeenCalled();
    expect(mockSendIdentityPushNotifications).not.toHaveBeenCalled();
  });

  it('dispatches an early warning for realtime in-app delivery without counting a mobile push', async () => {
    const source: SubscriptionCoverageSourceData = {
      consolidationKey: 'profile-key',
      hasDemonstratedIntent: true,
      balanceEth: '0.26116',
      mode: {
        automatic: true,
        subscribeAllEditions: false
      },
      eligibilityCount: 1,
      selections: []
    };
    const repository = {
      listDemonstratedIntentKeys: jest.fn(async () => ['profile-key']),
      loadSourceData: jest.fn(async () => new Map([['profile-key', source]])),
      resolveCanonicalProfiles: jest.fn(
        async () =>
          new Map([
            [
              'profile-key',
              { profileId: 'profile-id', handle: 'profile-handle' }
            ]
          ])
      ),
      readAlertStates: jest.fn(
        async () =>
          new Map([
            [
              'profile-key',
              {
                current_status: 'COVERED',
                current_fingerprint: 'covered',
                current_at_risk_token_id: null,
                current_fully_funded_drops: 7,
                current_requested_mints: null,
                current_missing_mints: null,
                recipient_profile_id: 'profile-id',
                last_notified_status: null,
                last_notified_fingerprint: null,
                last_notified_at: null
              }
            ]
          ])
      ),
      applyAlertSnapshot: jest.fn(async () => ({
        notificationIds: [42],
        notificationStatus: 'EARLY_WARNING',
        decisionReason: 'DETERIORATED',
        createdBaseline: false
      }))
    } as unknown as SubscriptionCoverageRepository;
    const scheduleProvider = {
      getSchedule: jest.fn(async () => ({
        drops: Array.from({ length: 8 }, (_unused, index) => ({
          tokenId: 528 + index,
          mintAt: new Date(
            Date.parse('2026-07-27T14:40:00.000Z') + index * 24 * 60 * 60 * 1000
          ).toISOString(),
          topUpDeadline: null
        })),
        basis: 'PROJECTED',
        deadlineBasis: 'UNAVAILABLE',
        horizon: 8,
        fetchedAt: '2026-07-26T22:00:00.000Z',
        truncated: true
      }))
    } as unknown as MemeCalendarScheduleProvider;
    const service = new SubscriptionCoverageReconciliationService(
      repository,
      scheduleProvider,
      () => Date.parse('2026-07-26T22:00:00.000Z')
    );

    const result = await service.reconcileFullPage(undefined, 100, {
      dryRun: false,
      notificationsEnabled: true,
      baselineOnly: false,
      notifyInitialCritical: false,
      pushEnabled: true
    });

    expect(result.notificationsCreated).toBe(1);
    expect(result.pushesQueued).toBe(0);
    expect(mockSendIdentityPushNotifications).toHaveBeenCalledWith([42]);
  });
});
