const mockSend = jest.fn();
const mockDue = jest.fn();
const mockSnapshot = jest.fn();
const mockForget = jest.fn();
jest.mock('@/api/ws/ws', () => ({ appWebSockets: { send: mockSend } }));
jest.mock('./ws-delivery-store', () => ({
  webSocketDeliveryStore: {
    due: mockDue,
    snapshot: mockSnapshot,
    forget: mockForget
  }
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));

import { recoverWebSocketDeliveries } from './ws-delivery-recovery';
import { DeliverySnapshot } from './ws-delivery-store';

const healthy: DeliverySnapshot = {
  attempted: 100,
  sent: 100,
  throttled: 0,
  deferred: 0,
  connections: 10,
  healthyConnections: 10,
  recentlyHealthyConnections: 10,
  throttledConnections: 0,
  pending: 0,
  oldestFailureAt: 0
};

describe('scheduled WebSocket refresh recovery', () => {
  let output: jest.SpyInstance;
  beforeEach(() => {
    jest.resetAllMocks();
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    mockDue.mockResolvedValue([]);
    mockSnapshot.mockResolvedValue(healthy);
    mockSend.mockResolvedValue({ status: 'sent' });
  });
  afterEach(() => output.mockRestore());
  it('sends only a content-free refresh marker and removes confirmed gone listeners', async () => {
    mockDue.mockResolvedValueOnce(['connection-a', 'connection-b']);
    mockSend
      .mockResolvedValueOnce({ status: 'sent' })
      .mockResolvedValueOnce({ status: 'gone' });
    await recoverWebSocketDeliveries();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith({
      connectionId: 'connection-a',
      message: '{"type":"RESYNC_REQUIRED","data":{}}',
      recovery: true
    });
    expect(mockForget).toHaveBeenCalledWith('connection-b');
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      Degraded: 0,
      WorkerHealthy: 1,
      Pending: 0
    });
  });
  it('reports a persistent one-listener outage even though the worker itself completes', async () => {
    mockSnapshot.mockResolvedValue({
      ...healthy,
      pending: 1,
      recentlyHealthyConnections: 0,
      oldestFailureAt: Date.now() - 180_000
    });
    await recoverWebSocketDeliveries();
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      Degraded: 1,
      WorkerHealthy: 1
    });
  });
  it('does not publish a healthy heartbeat when retry state cannot be inspected', async () => {
    mockSnapshot.mockRejectedValue(new Error('Redis unavailable'));
    await expect(recoverWebSocketDeliveries()).rejects.toThrow(
      'Redis unavailable'
    );
    expect(output).not.toHaveBeenCalled();
  });
  it('bounds each invocation to ten concurrent sends and 100 markers', async () => {
    mockDue.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => `connection-${index}`)
    );
    let inFlight = 0;
    let peak = 0;
    mockSend.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      return { status: 'resync_pending' };
    });
    await recoverWebSocketDeliveries();
    expect(mockSend).toHaveBeenCalledTimes(100);
    expect(peak).toBe(10);
  });
});
