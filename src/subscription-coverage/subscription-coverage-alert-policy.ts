import { SubscriptionCoverageStatus } from './subscription-coverage.types';

export type SubscriptionCoverageAlertStatus = `${SubscriptionCoverageStatus}`;

export interface SubscriptionCoverageAlertSnapshot {
  readonly consolidationKey: string;
  readonly status: SubscriptionCoverageAlertStatus;
  readonly fingerprint: string;
  readonly atRiskTokenId: number | null;
  readonly fullyFundedDrops: number;
  readonly requestedMints: number | null;
  readonly missingMints: number | null;
  readonly recipientProfileId: string | null;
}

export interface StoredSubscriptionCoverageAlertState {
  readonly current_status: SubscriptionCoverageAlertStatus;
  readonly current_fingerprint: string;
  readonly current_at_risk_token_id: number | null;
  readonly current_fully_funded_drops: number;
  readonly current_requested_mints: number | null;
  readonly current_missing_mints: number | null;
  readonly recipient_profile_id: string | null;
  readonly last_notified_status: SubscriptionCoverageAlertStatus | null;
  readonly last_notified_fingerprint: string | null;
  readonly last_notified_at: number | null;
}

export interface SubscriptionCoverageAlertPolicy {
  readonly notificationsEnabled: boolean;
  readonly baselineOnly: boolean;
  readonly notifyInitialCritical: boolean;
}

const WARNING_SEVERITY: Partial<
  Record<SubscriptionCoverageAlertStatus, number>
> = {
  [SubscriptionCoverageStatus.EarlyWarning]: 1,
  [SubscriptionCoverageStatus.RunningLow]: 2,
  [SubscriptionCoverageStatus.ActionRequired]: 3
};

export interface SubscriptionCoverageAlertDecision {
  readonly shouldNotify: boolean;
  readonly resetNotificationState: boolean;
  readonly reason:
    | 'DISABLED'
    | 'BASELINE'
    | 'INITIAL_SUPPRESSED'
    | 'INITIAL_CRITICAL'
    | 'NEUTRAL'
    | 'DETERIORATED'
    | 'RISK_CHANGED'
    | 'UNCHANGED';
}

function sameStatusRiskChangedMaterially(
  currentState: StoredSubscriptionCoverageAlertState,
  snapshot: SubscriptionCoverageAlertSnapshot
): boolean {
  if (
    snapshot.fullyFundedDrops < currentState.current_fully_funded_drops ||
    (snapshot.missingMints ?? 0) > (currentState.current_missing_mints ?? 0) ||
    (snapshot.requestedMints ?? 0) > (currentState.current_requested_mints ?? 0)
  ) {
    return true;
  }
  return (
    snapshot.fullyFundedDrops === currentState.current_fully_funded_drops &&
    snapshot.requestedMints === currentState.current_requested_mints &&
    snapshot.missingMints === currentState.current_missing_mints &&
    snapshot.atRiskTokenId !== currentState.current_at_risk_token_id
  );
}

export function decideSubscriptionCoverageAlert(
  currentState: StoredSubscriptionCoverageAlertState | null,
  snapshot: SubscriptionCoverageAlertSnapshot,
  policy: SubscriptionCoverageAlertPolicy
): SubscriptionCoverageAlertDecision {
  const nextSeverity = WARNING_SEVERITY[snapshot.status];
  if (nextSeverity === undefined) {
    return {
      shouldNotify: false,
      resetNotificationState: true,
      reason: 'NEUTRAL'
    };
  }
  if (!policy.notificationsEnabled) {
    return {
      shouldNotify: false,
      resetNotificationState: false,
      reason: 'DISABLED'
    };
  }
  if (policy.baselineOnly) {
    return {
      shouldNotify: false,
      resetNotificationState: false,
      reason: 'BASELINE'
    };
  }
  if (!currentState) {
    const shouldNotify =
      policy.notifyInitialCritical &&
      snapshot.status === SubscriptionCoverageStatus.ActionRequired;
    return {
      shouldNotify,
      resetNotificationState: false,
      reason: shouldNotify ? 'INITIAL_CRITICAL' : 'INITIAL_SUPPRESSED'
    };
  }

  const previousSeverity = WARNING_SEVERITY[currentState.current_status] ?? 0;
  if (nextSeverity > previousSeverity) {
    return {
      shouldNotify: true,
      resetNotificationState: false,
      reason: 'DETERIORATED'
    };
  }
  if (
    snapshot.status === currentState.current_status &&
    sameStatusRiskChangedMaterially(currentState, snapshot)
  ) {
    return {
      shouldNotify: true,
      resetNotificationState: false,
      reason: 'RISK_CHANGED'
    };
  }
  return {
    shouldNotify: false,
    resetNotificationState: false,
    reason: 'UNCHANGED'
  };
}
