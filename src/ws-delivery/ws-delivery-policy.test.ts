import { deliveryHealth, shouldReconnectListener } from './ws-delivery-policy';
import { DeliverySnapshot } from './ws-delivery-store';

const now = 1_000_000;
const healthy: DeliverySnapshot = {
  attempted: 1000,
  sent: 999,
  throttled: 1,
  deferred: 30,
  connections: 100,
  healthyConnections: 99,
  recentlyHealthyConnections: 99,
  throttledConnections: 1,
  pending: 1,
  oldestFailureAt: now - 180_000
};

describe('WebSocket fleet health', () => {
  it('keeps one persistently blocked listener quiet while other listeners work', () => {
    expect(deliveryHealth(healthy, now)).toBe('healthy');
    expect(shouldReconnectListener(healthy, 3, now - 180_000, now)).toBe(true);
  });
  it('alerts on failures spread across connections and prevents mass disconnections', () => {
    const fleet = {
      ...healthy,
      connections: 20,
      throttledConnections: 8,
      throttled: 20
    };
    expect(deliveryHealth(fleet, now)).toBe('widespread_throttling');
    expect(shouldReconnectListener(fleet, 10, now - 600_000, now)).toBe(false);
  });
  it('detects a persistent outage even with just one listener and old successes', () => {
    expect(
      deliveryHealth(
        {
          ...healthy,
          connections: 1,
          healthyConnections: 1,
          recentlyHealthyConnections: 0
        },
        now
      )
    ).toBe('persistent_outage');
  });
  it('allows short failures to recover without paging', () => {
    expect(
      deliveryHealth(
        {
          ...healthy,
          recentlyHealthyConnections: 0,
          oldestFailureAt: now - 30_000
        },
        now
      )
    ).toBe('healthy');
    expect(shouldReconnectListener(healthy, 1, now - 30_000, now)).toBe(false);
  });
  it('detects a retry backlog despite some successful deliveries', () => {
    expect(
      deliveryHealth(
        { ...healthy, pending: 100, oldestFailureAt: now - 300_000 },
        now
      )
    ).toBe('recovery_backlog');
  });
  it('clears the incident once there is no pending work or recent throttling', () => {
    expect(
      deliveryHealth(
        {
          ...healthy,
          pending: 0,
          throttled: 0,
          throttledConnections: 0,
          oldestFailureAt: 0
        },
        now
      )
    ).toBe('healthy');
  });
});
