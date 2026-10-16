import { DeliverySnapshot } from './ws-delivery-store';

export type DeliveryHealth =
  | 'healthy'
  | 'widespread_throttling'
  | 'persistent_outage'
  | 'recovery_backlog';

/** A single unhealthy listener cannot page an otherwise healthy fleet. */
export function deliveryHealth(
  snapshot: DeliverySnapshot,
  now: number
): DeliveryHealth {
  if (
    snapshot.throttledConnections >= 5 &&
    (snapshot.throttledConnections / Math.max(1, snapshot.connections) >= 0.2 ||
      snapshot.throttled >= 100 ||
      snapshot.throttled / Math.max(1, snapshot.attempted) >= 0.05) &&
    snapshot.throttled >= 10
  )
    return 'widespread_throttling';
  if (
    snapshot.pending > 0 &&
    snapshot.recentlyHealthyConnections === 0 &&
    snapshot.oldestFailureAt > 0 &&
    now - snapshot.oldestFailureAt >= 120_000
  )
    return 'persistent_outage';
  if (
    snapshot.pending >= 100 &&
    snapshot.oldestFailureAt > 0 &&
    now - snapshot.oldestFailureAt >= 300_000
  )
    return 'recovery_backlog';
  return 'healthy';
}

export function shouldReconnectListener(
  snapshot: DeliverySnapshot,
  failures: number,
  firstFailureAt: number,
  now: number
): boolean {
  return (
    failures >= 3 &&
    firstFailureAt > 0 &&
    now - firstFailureAt >= 120_000 &&
    snapshot.healthyConnections >= 3 &&
    snapshot.throttledConnections <=
      Math.max(1, Math.floor(snapshot.healthyConnections * 0.1)) &&
    deliveryHealth(snapshot, now) === 'healthy'
  );
}
