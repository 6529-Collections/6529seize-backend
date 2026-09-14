import {
  resolveSubscriptionCoverageReconciliationOptions,
  shouldStopSubscriptionCoverageReconciliation
} from './index';

describe('subscription coverage reconciliation rollout options', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SUBSCRIPTION_COVERAGE_DRY_RUN;
    delete process.env.SUBSCRIPTION_COVERAGE_BASELINE_ONLY;
    delete process.env.FEATURE_SUBSCRIPTION_COVERAGE_NOTIFICATIONS;
    delete process.env.SUBSCRIPTION_COVERAGE_NOTIFY_INITIAL_CRITICAL;
    delete process.env.SUBSCRIPTION_COVERAGE_PUSH_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('baselines safely while enabling later lifecycle transitions by default', () => {
    expect(resolveSubscriptionCoverageReconciliationOptions()).toEqual({
      dryRun: false,
      notificationsEnabled: true,
      baselineOnly: false,
      notifyInitialCritical: false,
      pushEnabled: true
    });
  });

  it('honors independent dry-run, baseline, notification, and push controls', () => {
    process.env.SUBSCRIPTION_COVERAGE_DRY_RUN = 'true';
    process.env.SUBSCRIPTION_COVERAGE_BASELINE_ONLY = 'true';
    process.env.FEATURE_SUBSCRIPTION_COVERAGE_NOTIFICATIONS = 'false';
    process.env.SUBSCRIPTION_COVERAGE_NOTIFY_INITIAL_CRITICAL = 'true';
    process.env.SUBSCRIPTION_COVERAGE_PUSH_ENABLED = 'false';

    expect(resolveSubscriptionCoverageReconciliationOptions()).toEqual({
      dryRun: true,
      notificationsEnabled: false,
      baselineOnly: true,
      notifyInitialCritical: true,
      pushEnabled: false
    });
  });
});

describe('subscription coverage reconciliation paging', () => {
  it('stops a dirty drain when every selected key fails', () => {
    expect(
      shouldStopSubscriptionCoverageReconciliation(
        {
          mode: 'DIRTY',
          scanned: 100,
          succeeded: 0,
          failed: 100,
          baselined: 0,
          notificationsCreated: 0,
          pushesQueued: 0,
          wouldNotify: 0,
          deduplicatedOrSuppressed: 0,
          unroutable: 0,
          statusCounts: {},
          hasMore: true,
          lastConsolidationKey: 'poison-key'
        },
        {
          dryRun: false,
          notificationsEnabled: true,
          baselineOnly: false,
          notifyInitialCritical: false,
          pushEnabled: true
        }
      )
    ).toBe(true);
  });
});
