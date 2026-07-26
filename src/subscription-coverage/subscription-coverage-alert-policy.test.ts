import {
  decideSubscriptionCoverageAlert,
  StoredSubscriptionCoverageAlertState,
  SubscriptionCoverageAlertSnapshot
} from './subscription-coverage-alert-policy';

const snapshot = (
  status: SubscriptionCoverageAlertSnapshot['status'],
  fingerprint = 'next-risk'
): SubscriptionCoverageAlertSnapshot => ({
  consolidationKey: 'key',
  status,
  fingerprint,
  atRiskTokenId: 528,
  fullyFundedDrops: 2,
  requestedMints: 3,
  missingMints: 1,
  recipientProfileId: 'profile'
});

const state = (
  status: StoredSubscriptionCoverageAlertState['current_status'],
  fingerprint = 'previous-risk'
): StoredSubscriptionCoverageAlertState => ({
  current_status: status,
  current_fingerprint: fingerprint,
  current_at_risk_token_id: 527,
  current_fully_funded_drops: 2,
  current_requested_mints: 3,
  current_missing_mints: 1,
  recipient_profile_id: 'profile',
  last_notified_status: status,
  last_notified_fingerprint: fingerprint,
  last_notified_at: 1
});

const enabledPolicy = {
  notificationsEnabled: true,
  baselineOnly: false,
  notifyInitialCritical: false
};

describe('decideSubscriptionCoverageAlert', () => {
  it('suppresses a missing baseline by default', () => {
    expect(
      decideSubscriptionCoverageAlert(
        null,
        snapshot('ACTION_REQUIRED'),
        enabledPolicy
      )
    ).toMatchObject({
      shouldNotify: false,
      reason: 'INITIAL_SUPPRESSED'
    });
  });

  it('allows an explicitly enabled initial critical notification', () => {
    expect(
      decideSubscriptionCoverageAlert(null, snapshot('ACTION_REQUIRED'), {
        ...enabledPolicy,
        notifyInitialCritical: true
      })
    ).toMatchObject({
      shouldNotify: true,
      reason: 'INITIAL_CRITICAL'
    });
  });

  it('notifies when severity worsens', () => {
    expect(
      decideSubscriptionCoverageAlert(
        state('EARLY_WARNING'),
        snapshot('RUNNING_LOW'),
        enabledPolicy
      )
    ).toMatchObject({ shouldNotify: true, reason: 'DETERIORATED' });
  });

  it('does not notify for a fingerprint-only balance change', () => {
    expect(
      decideSubscriptionCoverageAlert(
        {
          ...state('RUNNING_LOW'),
          current_at_risk_token_id: 528
        },
        snapshot('RUNNING_LOW', 'balance-only-change'),
        enabledPolicy
      )
    ).toMatchObject({ shouldNotify: false, reason: 'UNCHANGED' });
  });

  it('notifies when missing mints increase at the same severity', () => {
    expect(
      decideSubscriptionCoverageAlert(
        {
          ...state('RUNNING_LOW'),
          current_at_risk_token_id: 528
        },
        {
          ...snapshot('RUNNING_LOW'),
          missingMints: 2
        },
        enabledPolicy
      )
    ).toMatchObject({ shouldNotify: true, reason: 'RISK_CHANGED' });
  });

  it('notifies when the first at-risk Meme changes at the same severity', () => {
    expect(
      decideSubscriptionCoverageAlert(
        state('RUNNING_LOW'),
        snapshot('RUNNING_LOW'),
        enabledPolicy
      )
    ).toMatchObject({ shouldNotify: true, reason: 'RISK_CHANGED' });
  });

  it('does not notify when same-status coverage improves', () => {
    expect(
      decideSubscriptionCoverageAlert(
        {
          ...state('RUNNING_LOW'),
          current_at_risk_token_id: 528,
          current_fully_funded_drops: 2,
          current_missing_mints: 2
        },
        {
          ...snapshot('RUNNING_LOW'),
          fullyFundedDrops: 3,
          missingMints: 1
        },
        enabledPolicy
      )
    ).toMatchObject({ shouldNotify: false, reason: 'UNCHANGED' });
  });

  it('resets notification state after recovery or a neutral state', () => {
    expect(
      decideSubscriptionCoverageAlert(
        state('ACTION_REQUIRED'),
        snapshot('COVERED'),
        enabledPolicy
      )
    ).toMatchObject({
      shouldNotify: false,
      resetNotificationState: true,
      reason: 'NEUTRAL'
    });
  });
});
